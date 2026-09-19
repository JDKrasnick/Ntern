import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { URL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { Text, TouchableOpacity } = require('react-native-web') as typeof import('react-native');

describe('cross-platform accessibility state contract', () => {
  it('shows the grouped-role backdrop without sliding the whole screen', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    expect(app).toMatch(
      /<Modal visible=\{visible\} transparent animationType="none" onRequestClose=\{onDismiss\}>/,
    );
  });

  it('only queues a role after an explicit queue interaction', () => {
    const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'),
      ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const automaticQueueCalls: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect') {
        const effect = node.arguments[0];
        if (effect) {
          const inspectEffect = (child: ts.Node) => {
            if (ts.isCallExpression(child) && child.expression.getText(source) === 'addToQueue') {
              automaticQueueCalls.push(child.getText(source));
            }
            ts.forEachChild(child, inspectEffect);
          };
          inspectEffect(effect);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(automaticQueueCalls).toEqual([]);
  });

  it('lets the primary application label wrap without overlapping its icon at large text sizes', () => {
    const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'),
      ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const styles = new Map<string, Map<string, string>>();
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.initializer)) {
        const name = node.name.getText(source);
        if (['applyNowButton', 'applyNowTitle', 'applyNowArrow'].includes(name)) {
          styles.set(name, new Map(node.initializer.properties.filter(ts.isPropertyAssignment)
            .map(item => [item.name.getText(source), item.initializer.getText(source)])));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(styles.get('applyNowButton')?.get('flexDirection')).toBe('"row"');
    expect(styles.get('applyNowButton')?.has('height')).toBe(false);
    expect(styles.get('applyNowTitle')?.get('flex')).toBe('1');
    expect(styles.get('applyNowArrow')?.has('position')).toBe(false);
    expect(styles.get('applyNowArrow')?.get('flexShrink')).toBe('0');
  });

  it.each([
    ['radio', 'aria-checked', true],
    ['checkbox', 'aria-checked', false],
    ['tab', 'aria-selected', true],
    ['button', 'aria-expanded', false],
    ['button', 'aria-disabled', true],
  ] as const)('renders %s state through the installed web renderer', (role, state, value) => {
    const markup = renderToStaticMarkup(createElement(TouchableOpacity, {
      accessibilityRole: role, [state]: value,
    }, createElement(Text, null, 'Control')));
    expect(markup).toContain(`${state}="${value}"`);
  });

  it('wires every app radio, checkbox and tab to explicit cross-platform state', () => {
    // React Native Web 0.21 drops accessibilityState. Check the actual JSX
    // wiring as well as the installed renderer above; native-only unit mocks
    // otherwise allow the browser regression to pass unnoticed.
    const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'),
      ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const controls: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
        const names = attributes.map(item => item.name.getText(source));
        expect(names).not.toContain('accessibilityState');
        const role = attributes.find(item => item.name.getText(source) === 'accessibilityRole')?.initializer;
        if (role && ts.isStringLiteral(role) && ['radio', 'checkbox', 'tab'].includes(role.text)) {
          controls.push(role.text);
          expect(names, `${node.tagName.getText(source)} ${role.text}`).toContain(
            role.text === 'tab' ? 'aria-selected' : 'aria-checked');
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(controls).toEqual(expect.arrayContaining(['radio', 'checkbox', 'tab']));
  });
});
