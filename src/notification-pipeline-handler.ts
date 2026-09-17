import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { createCandidateRelease, createNotificationIntents, deliveryClaimId, logicalTombstoneId, renderReleaseEmail, renderReleasePush, type DeliveryClaim, type NotificationIntent } from './release-notifications.js';
import { canonicalCompanyKey } from './core/normalize.js';
import { classifyAwsServiceFailure, classifyExpoPushFailure, ExpoPushPublisher, SesEmailSender } from './notifications.js';
import { createDynamoDocumentClient, deletedUserTombstoneKey, DynamoInternshipStore, DynamoReleaseStore, DynamoUserStore } from './store.js';
import type { Internship, NotificationEvent } from './types.js';
import { loadGroupedNotificationCohort } from './grouped-notification-cohort.js';
import { alertEligible } from './catalog-admission.js';

type SqsRecord = { messageId: string; body: string };
type SqsEvent = { Records?: SqsRecord[] };
type StreamRecord = {
  eventID: string;
  eventName?: string;
  dynamodb?: { Keys?: Record<string, AttributeValue>; NewImage?: Record<string, AttributeValue> };
};
type StreamEvent = { Records?: StreamRecord[] };
type AttributeValue = { S?: string; N?: string; BOOL?: boolean; NULL?: boolean; M?: Record<string, AttributeValue>; L?: AttributeValue[]; SS?: string[] };

const catalogTable = process.env.INTERNSHIPS_TABLE ?? '';
const usersTable = process.env.USERS_TABLE ?? '';
const documentClient = createDynamoDocumentClient(new DynamoDBClient({}));
const jobs = new DynamoInternshipStore(catalogTable, documentClient);
const users = new DynamoUserStore(usersTable, documentClient);
const releases = new DynamoReleaseStore(usersTable, documentClient);
const sns = new SNSClient({});
const sqs = new SQSClient({});

function unmarshall(value: AttributeValue | undefined): unknown {
  if (!value) return undefined;
  if (value.S !== undefined) return value.S;
  if (value.N !== undefined) return Number(value.N);
  if (value.BOOL !== undefined) return value.BOOL;
  if (value.NULL) return null;
  if (value.SS) return new Set(value.SS);
  if (value.L) return value.L.map(unmarshall);
  if (value.M) return Object.fromEntries(Object.entries(value.M).map(([key, item]) => [key, unmarshall(item)]));
  return undefined;
}

function normalizedEmployer(company: string) {
  return canonicalCompanyKey(company).replace(/\s+/g, '-') || 'unknown';
}

function bucketId(employerId: string, event: NotificationEvent) {
  return createHash('sha256').update(`${employerId}\0${event.createdAt}\0${event.eventId}`).digest('hex').slice(0, 24);
}

export function candidateFitsActiveBucket(
  pointer: { bucketId?: string; flushAt?: string; closedAt?: string } | undefined,
  event: Pick<NotificationEvent, 'createdAt'>,
) {
  return Boolean(pointer?.bucketId && pointer.flushAt && !pointer.closedAt && event.createdAt <= pointer.flushAt);
}

export const EXPO_RECEIPT_DELAY_SECONDS = 15 * 60;
export const MAX_EXPO_RECEIPT_CHECKS = 8;

export function notificationCandidateEligible(job: Internship | undefined): job is Internship {
  return Boolean(job?.open && job.technical !== false && alertEligible(job));
}

export function notificationCandidatesForFlush(
  candidates: Array<Internship | undefined>,
): Internship[] {
  return candidates.filter((job) => notificationCandidateEligible(job));
}

export interface ReceiptMessage {
  claim: DeliveryClaim;
  ticketId: string;
  token: string;
  receiptCheckAttempt?: number;
  /** The accepted-ticket transaction needs repair before receipt lookup. */
  handoffPending?: boolean;
}

export function expoReceiptRetryDelaySeconds(attempt: number) {
  return Math.min(EXPO_RECEIPT_DELAY_SECONDS, 60 * 2 ** Math.min(Math.max(attempt, 0), 4));
}

export function nextReceiptCheck(message: ReceiptMessage): ReceiptMessage | undefined {
  const attempt = message.receiptCheckAttempt ?? 0;
  return attempt >= MAX_EXPO_RECEIPT_CHECKS ? undefined : { ...message, receiptCheckAttempt: attempt + 1 };
}

export function notificationStreamTarget(record: StreamRecord):
  | { kind: 'flush'; bucketId: string }
  | { kind: 'candidate'; notification: NotificationEvent }
  | { kind: 'receipt'; message: ReceiptMessage }
  | undefined {
  const pk = record.dynamodb?.Keys?.pk?.S;
  const sk = record.dynamodb?.Keys?.sk?.S;
  if (record.eventName !== 'INSERT' || !pk) return undefined;
  if (pk.startsWith('RELEASE_BUCKET#')) return { kind: 'flush', bucketId: pk.slice('RELEASE_BUCKET#'.length) };
  if (pk.startsWith('PIPELINE_RECEIPT_OUTBOX#') || (pk.startsWith('USER#') && sk?.startsWith('PIPELINE_RECEIPT_OUTBOX#'))) {
    const message = unmarshall(record.dynamodb?.NewImage?.message) as ReceiptMessage | undefined;
    return message ? { kind: 'receipt', message } : undefined;
  }
  if (!pk.startsWith('OUTBOX#')) return undefined;
  const notification = unmarshall(record.dynamodb?.NewImage?.event) as NotificationEvent | undefined;
  return notification?.kind === 'new-job' ? { kind: 'candidate', notification } : undefined;
}

async function streamPublisher(event: StreamEvent) {
  const failures: Array<{ itemIdentifier: string }> = [];
  for (const record of event.Records ?? []) {
    try {
      const target = notificationStreamTarget(record);
      if (target?.kind === 'flush') {
        await sqs.send(new SendMessageCommand({
          QueueUrl: process.env.FLUSH_QUEUE_URL,
          MessageBody: JSON.stringify({ bucketId: target.bucketId }),
        }));
        continue;
      }
      if (target?.kind === 'receipt') {
        await sqs.send(new SendMessageCommand({
          QueueUrl: process.env.RECEIPT_QUEUE_URL,
          MessageBody: JSON.stringify(target.message),
          DelaySeconds: EXPO_RECEIPT_DELAY_SECONDS,
        }));
        continue;
      }
      if (target?.kind !== 'candidate') continue;
      await sns.send(new PublishCommand({ TopicArn: process.env.CANDIDATE_TOPIC_ARN, Message: JSON.stringify(target.notification) }));
    } catch { failures.push({ itemIdentifier: record.eventID }); }
  }
  return { batchItemFailures: failures };
}

async function aggregateCandidate(event: NotificationEvent) {
  const job = await jobs.getJob(event.jobId);
  if (!notificationCandidateEligible(job)) return;
  const employerId = normalizedEmployer(job.company);
  const pointerKey = { pk: `RELEASE_AGGREGATION#${employerId}`, sk: 'ACTIVE' };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const pointer = (await documentClient.send(new GetCommand({ TableName: catalogTable, Key: pointerKey, ConsistentRead: true }))).Item as { bucketId?: string; flushAt?: string; closedAt?: string } | undefined;
    if (candidateFitsActiveBucket(pointer, event) && pointer?.bucketId) {
      try {
        await documentClient.send(new UpdateCommand({
          TableName: catalogTable,
          Key: { pk: `RELEASE_BUCKET#${pointer.bucketId}`, sk: 'META' },
          UpdateExpression: 'ADD jobIds :jobIds',
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(closedAt)',
          ExpressionAttributeValues: { ':jobIds': new Set([event.jobId]) },
        }));
        await sqs.send(new SendMessageCommand({ QueueUrl: process.env.FLUSH_QUEUE_URL, MessageBody: JSON.stringify({ bucketId: pointer.bucketId }) }));
        return;
      } catch (error) {
        if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
        // The flush won the race. Replace the processed pointer with a fresh
        // bucket below so this candidate is never stranded after the flush.
      }
    }
    const id = bucketId(employerId, event);
    const flushAt = new Date(Date.parse(event.createdAt) + 8_000).toISOString();
    const condition = pointer?.bucketId ? '#bucketId = :prior' : 'attribute_not_exists(pk)';
    try {
      await documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: catalogTable, Item: { pk: `RELEASE_BUCKET#${id}`, sk: 'META', bucketId: id, employerId, company: job.company, openedAt: event.createdAt, flushAt, jobIds: new Set([event.jobId]), expiresAtEpoch: Math.floor(Date.parse(flushAt) / 1_000) + 86_400 }, ConditionExpression: 'attribute_not_exists(pk)' } },
        { Put: { TableName: catalogTable, Item: { ...pointerKey, bucketId: id, openedAt: event.createdAt, flushAt }, ConditionExpression: condition, ...(pointer?.bucketId ? { ExpressionAttributeNames: { '#bucketId': 'bucketId' }, ExpressionAttributeValues: { ':prior': pointer.bucketId } } : {}) } },
      ] }));
      // Keep direct scheduling during the compatibility rollout. The catalog
      // stream is the durable outbox; duplicate flush messages are idempotent.
      await sqs.send(new SendMessageCommand({ QueueUrl: process.env.FLUSH_QUEUE_URL, MessageBody: JSON.stringify({ bucketId: id }) }));
      return;
    } catch (error) {
      if ((error as { name?: string }).name !== 'TransactionCanceledException' || attempt === 3) throw error;
    }
  }
}

async function aggregationWorker(event: SqsEvent) {
  return handleSqs(event, async (record) => aggregateCandidate(JSON.parse(record.body) as NotificationEvent));
}

async function flushBucket(message: { bucketId: string }) {
  const attemptedAt = new Date();
  const bucketKey = { pk: `RELEASE_BUCKET#${message.bucketId}`, sk: 'META' };
  const result = await documentClient.send(new GetCommand({ TableName: catalogTable, Key: bucketKey, ConsistentRead: true }));
  const initial = result.Item as { employerId?: string; openedAt?: string; closedAt?: string; processedAt?: string } | undefined;
  if (!initial?.employerId || !initial.openedAt || initial.processedAt) return;
  const closedAt = initial.closedAt ?? attemptedAt.toISOString();
  if (!initial.closedAt) {
    try {
      // Close aggregation before reading the final job set. An aggregation
      // update that won before this close is visible in the reread; a later
      // update fails its closedAt condition and creates a fresh bucket instead.
      await documentClient.send(new UpdateCommand({
        TableName: catalogTable, Key: bucketKey,
        UpdateExpression: 'SET closedAt = :now', ConditionExpression: 'attribute_not_exists(closedAt)',
        ExpressionAttributeValues: { ':now': closedAt },
      }));
    } catch (error) {
      if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
    }
  }
  try {
    await documentClient.send(new UpdateCommand({
      TableName: catalogTable, Key: { pk: `RELEASE_AGGREGATION#${initial.employerId}`, sk: 'ACTIVE' },
      UpdateExpression: 'SET closedAt = :now', ConditionExpression: 'bucketId = :bucketId',
      ExpressionAttributeValues: { ':now': closedAt, ':bucketId': message.bucketId },
    }));
  } catch (error) {
    if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
  }
  const final = await documentClient.send(new GetCommand({ TableName: catalogTable, Key: bucketKey, ConsistentRead: true }));
  const bucket = final.Item as { openedAt?: string; jobIds?: Set<string> } | undefined;
  if (!bucket?.openedAt) return;
  const releaseJobs = notificationCandidatesForFlush(
    await Promise.all([...(bucket.jobIds ?? [])].map((jobId) => jobs.getJob(jobId))),
  );
  if (releaseJobs.length) {
    const candidate = createCandidateRelease(releaseJobs, new Date(bucket.openedAt));
    const cohortParameterName = process.env.GROUPED_NOTIFICATION_COHORT_PARAMETER_NAME;
    if (!cohortParameterName) throw new Error('GROUPED_NOTIFICATION_COHORT_PARAMETER_NAME is required');
    const configuredCohort = await loadGroupedNotificationCohort(cohortParameterName);
    const allUsers = configuredCohort === '*';
    const cohort = configuredCohort === '*' ? new Set<string>() : configuredCohort;
    const preferences = (await users.activePreferences()).filter((preference) => allUsers || cohort.has(preference.userId));
    for (const preference of preferences) {
      const channels = ['push', ...(preference.emailAlertsEnabled ? ['email' as const] : [])] as const;
      const intents = createNotificationIntents(candidate, preference.userId, preference.filter, [...channels], new Date(), preference.alertSettings?.quietHours);
      if (!intents.length) continue;
      const matchedJobIds = [...new Set(intents.flatMap((intent) => intent.release.jobs.map((job) => job.jobId)))].sort();
      await releases.putRelease({ releaseId: candidate.releaseId, userId: preference.userId, jobIds: matchedJobIds, newJobIds: matchedJobIds, createdAt: candidate.flushAt });
      for (const intent of intents) await sns.send(new PublishCommand({
        TopicArn: process.env.INTENT_TOPIC_ARN,
        Message: JSON.stringify(intent),
        MessageAttributes: { channel: { DataType: 'String', StringValue: intent.channel } },
      }));
    }
  }
  await documentClient.send(new UpdateCommand({
    TableName: catalogTable, Key: bucketKey,
    UpdateExpression: 'SET processedAt = :now',
    ExpressionAttributeValues: { ':now': new Date().toISOString() },
  }));
}

async function flushWorker(event: SqsEvent) {
  return handleSqs(event, async (record) => flushBucket(JSON.parse(record.body) as { bucketId: string }));
}

async function deferIntent(intent: NotificationIntent, queueUrl: string) {
  const remaining = Date.parse(intent.eligibleAt) - Date.now();
  if (remaining <= 0) return false;
  await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(intent), DelaySeconds: Math.min(900, Math.max(1, Math.ceil(remaining / 1_000))) }));
  return true;
}

async function claimDelivery(intent: NotificationIntent, destinationId: string): Promise<DeliveryClaim | undefined> {
  const jobIds = intent.release.newlyMatchedJobIds;
  const tombstoneId = logicalTombstoneId(intent.release.userId, intent.channel, intent.release.releaseId, jobIds);
  const claimId = deliveryClaimId(tombstoneId, destinationId);
  const now = new Date().toISOString();
  const claim: DeliveryClaim = { claimId, tombstoneId, userId: intent.release.userId, channel: intent.channel, destinationId, releaseId: intent.release.releaseId, jobIds, state: 'claimed', createdAt: now, updatedAt: now };
  try {
    const userKey = `USER#${claim.userId}`;
    const writes: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']> = [
      { ConditionCheck: { TableName: usersTable, Key: deletedUserTombstoneKey(claim.userId), ConditionExpression: 'attribute_not_exists(pk)' } },
      { Put: { TableName: usersTable, Item: { pk: userKey, sk: `DELIVERY#${claimId}`, kind: 'delivery-claim', claim }, ConditionExpression: 'attribute_not_exists(pk)' } },
    ];
    if (intent.channel === 'email') writes.push({ Put: { TableName: usersTable, Item: { pk: userKey, sk: `DELIVERY_TOMBSTONE#${tombstoneId}`, kind: 'delivery-tombstone', createdAt: now }, ConditionExpression: 'attribute_not_exists(pk)' } });
    await documentClient.send(new TransactWriteCommand({ TransactItems: writes }));
    return claim;
  } catch (error) {
    if ((error as { name?: string }).name === 'TransactionCanceledException') return undefined;
    throw error;
  }
}

export async function transitionClaim(claim: DeliveryClaim, state: DeliveryClaim['state'], providerId?: string, client = documentClient) {
  try {
    await client.send(new UpdateCommand({
      TableName: usersTable, Key: { pk: `USER#${claim.userId}`, sk: `DELIVERY#${claim.claimId}` },
      UpdateExpression: `SET claim.#state = :state, claim.updatedAt = :now${providerId ? ', claim.providerId = :providerId' : ''}`,
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: { ':state': state, ':now': new Date().toISOString(), ...(providerId ? { ':providerId': providerId } : {}) },
    }));
    return true;
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw error;
  }
}

async function acceptPushWithReceiptOutbox(claim: DeliveryClaim, ticketId: string, token: string): Promise<boolean> {
  const updatedAt = new Date().toISOString();
  const accepted = { ...claim, state: 'accepted' as const, providerId: ticketId, updatedAt };
  const outboxKey = { pk: `USER#${claim.userId}`, sk: `PIPELINE_RECEIPT_OUTBOX#${claim.claimId}#${ticketId}` };
  const write = () => documentClient.send(new TransactWriteCommand({ TransactItems: [
    { ConditionCheck: { TableName: usersTable, Key: deletedUserTombstoneKey(claim.userId), ConditionExpression: 'attribute_not_exists(pk)' } },
    { Update: {
      TableName: usersTable, Key: { pk: `USER#${claim.userId}`, sk: `DELIVERY#${claim.claimId}` },
      UpdateExpression: 'SET claim = :claim', ConditionExpression: 'claim.#state = :claimed',
      ExpressionAttributeNames: { '#state': 'state' }, ExpressionAttributeValues: { ':claim': accepted, ':claimed': 'claimed' },
    } },
    { Put: {
      TableName: usersTable,
      Item: { ...outboxKey, kind: 'pipeline-receipt-outbox', message: { claim: accepted, ticketId, token }, expiresAtEpoch: Math.floor(Date.now() / 1_000) + 24 * 60 * 60 },
      ConditionExpression: 'attribute_not_exists(pk)',
    } },
  ] }));
  try {
    await write();
    return true;
  } catch (error) {
    if ((error as { name?: string }).name !== 'TransactionCanceledException') throw error;
    // A client timeout can occur after DynamoDB commits both writes. Read the
    // durable state before retrying so the repair path is safe and idempotent.
    const [claimResult, outboxResult] = await Promise.all([
      documentClient.send(new GetCommand({ TableName: usersTable, Key: { pk: `USER#${claim.userId}`, sk: `DELIVERY#${claim.claimId}` }, ConsistentRead: true })),
      documentClient.send(new GetCommand({ TableName: usersTable, Key: outboxKey, ConsistentRead: true })),
    ]);
    if (outboxResult.Item) return true;
    const storedClaim = claimResult.Item?.claim as DeliveryClaim | undefined;
    if (!storedClaim) return false;
    if (storedClaim.state !== 'accepted' || storedClaim.providerId !== ticketId) throw error;
    // The claim was accepted but the outbox row is missing. Repair that
    // durable handoff before acknowledging the push queue message.
    await documentClient.send(new TransactWriteCommand({ TransactItems: [
      { ConditionCheck: { TableName: usersTable, Key: deletedUserTombstoneKey(claim.userId), ConditionExpression: 'attribute_not_exists(pk)' } },
      { Put: {
        TableName: usersTable,
        Item: { ...outboxKey, kind: 'pipeline-receipt-outbox', message: { claim: storedClaim, ticketId, token }, expiresAtEpoch: Math.floor(Date.now() / 1_000) + 24 * 60 * 60 },
        ConditionExpression: 'attribute_not_exists(pk)',
      } },
    ] }));
    return true;
  }
}

async function retryReceipt(message: ReceiptMessage) {
  const next = nextReceiptCheck(message);
  if (!next) return false;
  await sqs.send(new SendMessageCommand({
    QueueUrl: process.env.RECEIPT_QUEUE_URL,
    MessageBody: JSON.stringify(next),
    DelaySeconds: expoReceiptRetryDelaySeconds(message.receiptCheckAttempt ?? 0),
  }));
  return true;
}

async function abandonRetryableClaim(claim: DeliveryClaim) {
  const writes: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']> = [{ Delete: {
    TableName: usersTable, Key: { pk: `USER#${claim.userId}`, sk: `DELIVERY#${claim.claimId}` },
    ConditionExpression: 'claim.#state = :claimed',
    ExpressionAttributeNames: { '#state': 'state' }, ExpressionAttributeValues: { ':claimed': 'claimed' },
  } }];
  if (claim.channel === 'email') writes.push({ Delete: {
    TableName: usersTable, Key: { pk: `USER#${claim.userId}`, sk: `DELIVERY_TOMBSTONE#${claim.tombstoneId}` },
  } });
  await documentClient.send(new TransactWriteCommand({ TransactItems: writes }));
}

async function deliverPush(intent: NotificationIntent) {
  if (await deferIntent(intent, process.env.PUSH_QUEUE_URL ?? '')) return;
  const devices = (await users.activeDevices()).filter((device) => device.userId === intent.release.userId);
  const publisher = new ExpoPushPublisher();
  for (const device of devices) {
    const claim = await claimDelivery(intent, device.token);
    if (!claim) continue;
    try {
      const ticket = await publisher.publish(device.token, renderReleasePush(intent.release));
      if (ticket.status !== 'ok') {
        await transitionClaim(claim, 'definitive-failure', ticket.id);
        if (ticket.details?.error === 'DeviceNotRegistered') await users.putDevice({ ...device, active: false, updatedAt: new Date().toISOString() });
      } else if (!ticket.id) await transitionClaim(claim, 'unknown');
      else {
        try {
          await acceptPushWithReceiptOutbox(claim, ticket.id, device.token);
        } catch {
          // The provider accepted the push. If the claim/outbox transaction
          // was ambiguous, let the receipt worker repair it without replaying
          // the provider call or creating a second delivery claim.
          if (!await retryReceipt({ claim, ticketId: ticket.id, token: device.token, handoffPending: true })) {
            await transitionClaim(claim, 'unknown', ticket.id);
          }
        }
      }
    } catch (error) {
      const failure = classifyExpoPushFailure(error);
      if (failure === 'retryable') {
        await abandonRetryableClaim(claim);
        throw error;
      }
      await transitionClaim(claim, failure);
    }
  }
}

async function pushWorker(event: SqsEvent) {
  return handleSqs(event, async (record) => deliverPush(JSON.parse(record.body) as NotificationIntent));
}

async function deliverEmail(intent: NotificationIntent) {
  if (await deferIntent(intent, process.env.EMAIL_QUEUE_URL ?? '')) return;
  const profile = await users.getProfile(intent.release.userId);
  const email = profile?.contact.email;
  if (!email) return;
  const claim = await claimDelivery(intent, createHash('sha256').update(email.toLowerCase()).digest('hex'));
  if (!claim) return;
  const rendered = renderReleaseEmail(intent.release);
  try {
    await new SesEmailSender(process.env.SES_FROM ?? '', email).send(rendered.subject, rendered.text, `<pre>${rendered.text.replace(/[&<>]/g, (value) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[value]!))}</pre>`);
  } catch (error) {
    const failure = classifyAwsServiceFailure(error);
    if (failure === 'retryable') {
      await abandonRetryableClaim(claim);
      throw error;
    }
    await transitionClaim(claim, failure);
    return;
  }
  await transitionClaim(claim, 'delivered');
}

async function emailWorker(event: SqsEvent) {
  return handleSqs(event, async (record) => deliverEmail(JSON.parse(record.body) as NotificationIntent));
}

async function receiptWorker(event: SqsEvent) {
  const publisher = new ExpoPushPublisher();
  return handleSqs(event, async (record) => {
    const message = JSON.parse(record.body) as ReceiptMessage;
    if (message.handoffPending) {
      try {
        if (!await acceptPushWithReceiptOutbox(message.claim, message.ticketId, message.token)) return;
      } catch {
        if (await retryReceipt(message)) return;
        await transitionClaim(message.claim, 'unknown', message.ticketId);
        return;
      }
    }
    let receipt;
    try {
      receipt = (await publisher.receipts([message.ticketId]))[message.ticketId];
    } catch {
      if (await retryReceipt({ ...message, handoffPending: undefined })) return;
      await transitionClaim(message.claim, 'unknown', message.ticketId);
      return;
    }
    if (!receipt) {
      if (await retryReceipt({ ...message, handoffPending: undefined })) return;
      await transitionClaim(message.claim, 'unknown', message.ticketId);
      return;
    }
    if (!await transitionClaim(message.claim, receipt.status === 'ok' ? 'delivered' : 'definitive-failure', message.ticketId)) return;
    if (receipt.details?.error === 'DeviceNotRegistered') {
      const device = (await users.activeDevices()).find((candidate) => candidate.userId === message.claim.userId && candidate.token === message.token);
      if (device) await users.putDevice({ ...device, active: false, updatedAt: new Date().toISOString() });
    }
  });
}

async function handleSqs(event: SqsEvent, action: (record: SqsRecord) => Promise<void>) {
  const failures: Array<{ itemIdentifier: string }> = [];
  for (const record of event.Records ?? []) {
    try { await action(record); } catch { failures.push({ itemIdentifier: record.messageId }); }
  }
  return { batchItemFailures: failures };
}

export async function handler(event: SqsEvent | StreamEvent) {
  if (!catalogTable || !usersTable) throw new Error('INTERNSHIPS_TABLE and USERS_TABLE are required');
  switch (process.env.PIPELINE_COMMAND) {
    case 'stream-publisher': return streamPublisher(event as StreamEvent);
    case 'aggregate': return aggregationWorker(event as SqsEvent);
    case 'flush': return flushWorker(event as SqsEvent);
    case 'push': return pushWorker(event as SqsEvent);
    case 'email': return emailWorker(event as SqsEvent);
    case 'receipt': return receiptWorker(event as SqsEvent);
    default: throw new Error('PIPELINE_COMMAND is invalid');
  }
}
