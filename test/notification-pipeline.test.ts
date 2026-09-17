import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ses from 'aws-cdk-lib/aws-ses';
import { describe, expect, it, vi } from 'vitest';
import { NotificationPipeline } from '../infra/notification-pipeline.js';
import { candidateFitsActiveBucket, EXPO_RECEIPT_DELAY_SECONDS, expoReceiptRetryDelaySeconds, MAX_EXPO_RECEIPT_CHECKS,
  nextReceiptCheck, notificationStreamTarget,
  transitionClaim } from '../src/notification-pipeline-handler.js';
import type { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

function pipelineStack(releaseWindow = cdk.Duration.seconds(8)) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'PipelineTest');
  const catalogTable = new dynamodb.Table(stack, 'Catalog', {
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
  });
  const usersTable = new dynamodb.Table(stack, 'Users', {
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
  });
  const handler = (id: string) => new lambda.Function(stack, id, {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => ({ batchItemFailures: [] });'),
  });
  const identity = new ses.EmailIdentity(stack, 'EmailIdentity', {
    identity: ses.Identity.email('alerts@example.com'),
  });
  new NotificationPipeline(stack, 'Pipeline', {
    catalogTable,
    usersTable,
    emailIdentity: identity,
    releaseWindow,
    handlers: {
      streamPublisher: handler('StreamPublisher'),
      aggregationWorker: handler('AggregationWorker'),
      flushWorker: handler('FlushWorker'),
      pushWorker: handler('PushWorker'),
      emailWorker: handler('EmailWorker'),
      receiptWorker: handler('ReceiptWorker'),
    },
  });
  return stack;
}

describe('NotificationPipeline', () => {
  it('starts a fresh release when a delayed candidate reaches a processed bucket', () => {
    const event = { createdAt: '2026-08-24T00:00:05.000Z' };
    expect(candidateFitsActiveBucket({ bucketId: 'bucket', flushAt: '2026-08-24T00:00:08.000Z' }, event)).toBe(true);
    expect(candidateFitsActiveBucket({ bucketId: 'bucket', flushAt: '2026-08-24T00:00:08.000Z', closedAt: '2026-08-24T00:00:09.000Z' }, event)).toBe(false);
  });
  it('uses the durable bucket insert as the delayed-flush outbox', () => {
    expect(notificationStreamTarget({
      eventID: 'bucket-insert', eventName: 'INSERT', dynamodb: { Keys: { pk: { S: 'RELEASE_BUCKET#bucket-1' } } },
    })).toEqual({ kind: 'flush', bucketId: 'bucket-1' });
    expect(notificationStreamTarget({
      eventID: 'bucket-update', eventName: 'MODIFY', dynamodb: { Keys: { pk: { S: 'RELEASE_BUCKET#bucket-1' } } },
    })).toBeUndefined();
  });
  it('uses a user-owned durable outbox after Expo accepts a ticket', () => {
    const claim = { claimId: 'claim-1', tombstoneId: 'tombstone-1', userId: 'user-1', channel: 'push', destinationId: 'token', releaseId: 'release-1', jobIds: ['job-1'], state: 'accepted', createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:01.000Z' };
    expect(notificationStreamTarget({
      eventID: 'receipt-outbox', eventName: 'INSERT',
      dynamodb: {
        Keys: { pk: { S: 'USER#user-1' }, sk: { S: 'PIPELINE_RECEIPT_OUTBOX#claim-1#ticket-1' } },
        NewImage: { message: { M: {
          claim: { M: Object.fromEntries(Object.entries(claim).map(([key, value]) => [key, Array.isArray(value) ? { L: value.map((item) => ({ S: item })) } : { S: value }])) },
          ticketId: { S: 'ticket-1' }, token: { S: 'token' },
        } } },
      },
    })).toMatchObject({ kind: 'receipt', message: { ticketId: 'ticket-1', token: 'token', claim: { claimId: 'claim-1', state: 'accepted' } } });
  });
  it('does not recreate a delivery claim when a late receipt arrives after account deletion', async () => {
    const claim = { claimId: 'claim-1', tombstoneId: 'tombstone-1', userId: 'user-1', channel: 'push' as const, destinationId: 'token', releaseId: 'release-1', jobIds: ['job-1'], state: 'accepted' as const, createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:01.000Z' };
    const send = vi.fn().mockRejectedValue(Object.assign(new Error('deleted'), { name: 'ConditionalCheckFailedException' }));
    await expect(transitionClaim(claim, 'delivered', 'ticket-1', { send } as unknown as DynamoDBDocumentClient)).resolves.toBe(false);
    expect((send.mock.calls[0]?.[0] as UpdateCommand).input).toMatchObject({
      Key: { pk: 'USER#user-1', sk: 'DELIVERY#claim-1' },
      ConditionExpression: 'attribute_exists(pk)',
    });
  });
  it('waits fifteen minutes before checking Expo receipts', () => {
    expect(EXPO_RECEIPT_DELAY_SECONDS).toBe(900);
  });
  it('bounds receipt retries and backs them off instead of sending a receipt to the DLQ while pending', () => {
    const message = {
      claim: { claimId: 'claim-1' } as never,
      ticketId: 'ticket-1',
      token: 'token',
      handoffPending: true,
    };
    expect(nextReceiptCheck(message)).toMatchObject({ receiptCheckAttempt: 1, handoffPending: true });
    expect(nextReceiptCheck({ ...message, receiptCheckAttempt: MAX_EXPO_RECEIPT_CHECKS })).toBeUndefined();
    expect(expoReceiptRetryDelaySeconds(0)).toBe(60);
    expect(expoReceiptRetryDelaySeconds(4)).toBe(900);
    expect(expoReceiptRetryDelaySeconds(99)).toBe(900);
  });
  it('builds encrypted SNS/SQS fanout with 14-day dead-letter queues', () => {
    const template = Template.fromStack(pipelineStack());
    template.resourceCountIs('AWS::SNS::Topic', 2);
    template.resourceCountIs('AWS::SNS::Subscription', 3);
    template.resourceCountIs('AWS::SQS::Queue', 11);
    template.resourceCountIs('AWS::KMS::Key', 1);
    template.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
    template.hasResourceProperties('AWS::SQS::Queue', {
      DelaySeconds: 8,
      SqsManagedSseEnabled: true,
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 4 }),
    });
    template.hasResourceProperties('AWS::SQS::Queue', {
      MessageRetentionPeriod: 1_209_600,
      SqsManagedSseEnabled: true,
    });
    template.hasResourceProperties('AWS::SNS::Subscription', {
      RawMessageDelivery: true,
      FilterPolicy: { channel: ['push'] },
      Protocol: 'sqs',
    });
    template.hasResourceProperties('AWS::SNS::Subscription', {
      RawMessageDelivery: true,
      FilterPolicy: { channel: ['email'] },
      Protocol: 'sqs',
    });
  });

  it('uses partial batches, bounded retries and queue-age alarms', () => {
    const template = Template.fromStack(pipelineStack());
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 7);
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      StartingPosition: 'LATEST',
      BatchSize: 10,
      MaximumRetryAttempts: 3,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      DestinationConfig: { OnFailure: { Destination: Match.anyValue() } },
    });
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      StartingPosition: 'TRIM_HORIZON',
      FilterCriteria: { Filters: [{ Pattern: Match.stringLikeRegexp('PIPELINE_RECEIPT_OUTBOX') }] },
      EventSourceArn: Match.anyValue(),
    });
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 10,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      ScalingConfig: { MaximumConcurrency: 4 },
    });
    template.resourceCountIs('AWS::CloudWatch::Alarm', 5);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'ApproximateAgeOfOldestMessage',
      Period: 60,
      Threshold: 60,
      EvaluationPeriods: 2,
      TreatMissingData: 'notBreaching',
    });
  });

  it('rejects release windows outside the one-to-ten-second product boundary', () => {
    expect(() => pipelineStack(cdk.Duration.seconds(11))).toThrow(/between one and ten seconds/);
    expect(() => pipelineStack(cdk.Duration.seconds(0))).toThrow(/between one and ten seconds/);
  });
});
