import test from 'node:test';
import assert from 'node:assert/strict';

import { __testing } from './persistent-query-service.js';

function createQueryFactory() {
  const runtimes = [];
  return {
    runtimes,
    queryFn({ prompt, options }) {
      const runtime = {
        prompt,
        options,
        closed: false,
        setPermissionMode: async () => {},
        setModel: async () => {},
        setMaxThinkingTokens: async () => {},
        close() {
          this.closed = true;
        },
        async next() {
          return { done: true, value: undefined };
        }
      };
      runtimes.push(runtime);
      return runtime;
    }
  };
}

test.beforeEach(async () => {
  await __testing.resetState();
});

test.after(async () => {
  await __testing.resetState();
});

test('anonymous runtime is isolated by runtimeSessionEpoch', async () => {
  const factory = createQueryFactory();
  __testing.setQueryFn(factory.queryFn);

  const firstContext = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-1',
    cwd: process.cwd(),
    message: 'hello'
  }, false);

  const runtime1 = await __testing.acquireRuntime(firstContext);
  const runtime1Again = await __testing.acquireRuntime(firstContext);
  assert.equal(runtime1, runtime1Again);
  assert.equal(factory.runtimes.length, 1);

  const secondContext = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-2',
    cwd: process.cwd(),
    message: 'hello again'
  }, false);

  const runtime2 = await __testing.acquireRuntime(secondContext);
  assert.notEqual(runtime1, runtime2);
  assert.equal(factory.runtimes.length, 2);
});

test('same-tab new-session isolation matches fresh runtime isolation expectations', async () => {
  const factory = createQueryFactory();
  __testing.setQueryFn(factory.queryFn);

  const firstContext = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-a',
    cwd: process.cwd(),
    message: 'first turn'
  }, false);
  const runtimeA = await __testing.acquireRuntime(firstContext);

  await __testing.resetRuntimePersistent({ runtimeSessionEpoch: 'epoch-a' });

  const secondContext = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-b',
    cwd: process.cwd(),
    message: 'new session turn'
  }, false);
  const runtimeB = await __testing.acquireRuntime(secondContext);

  assert.notEqual(runtimeA, runtimeB);
  assert.equal(factory.runtimes.length, 2);
  assert.equal(__testing.getSnapshot().anonymousRuntimeCount, 1);
});

test('resetRuntimePersistent disposes active turn runtime for interrupted old epoch before next first send', async () => {
  const factory = createQueryFactory();
  __testing.setQueryFn(factory.queryFn);

  const oldContext = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-old',
    cwd: process.cwd(),
    message: 'streaming turn'
  }, false);
  const oldRuntime = await __testing.acquireRuntime(oldContext);
  __testing.setActiveTurnRuntime(oldRuntime);

  await __testing.resetRuntimePersistent({ runtimeSessionEpoch: 'epoch-old' });

  const nextContext = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-new',
    cwd: process.cwd(),
    message: 'first send after interrupt'
  }, false);
  const nextRuntime = await __testing.acquireRuntime(nextContext);

  assert.equal(oldRuntime.closed, true);
  assert.notEqual(oldRuntime, nextRuntime);
  assert.equal(__testing.getSnapshot().activeTurnEpoch, null);
});

test('restore-history continuation keeps runtime bound to restored session after reset of prior epoch', async () => {
  const factory = createQueryFactory();
  __testing.setQueryFn(factory.queryFn);

  const oldAnonymousContext = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-stale',
    cwd: process.cwd(),
    message: 'stale anonymous'
  }, false);
  await __testing.acquireRuntime(oldAnonymousContext);
  await __testing.resetRuntimePersistent({ runtimeSessionEpoch: 'epoch-stale' });

  const restoredContext = await __testing.buildRequestContext({
    sessionId: 'hist-restore',
    runtimeSessionEpoch: 'epoch-restore',
    cwd: process.cwd(),
    message: 'restored continuation'
  }, false);
  const restoredRuntime = await __testing.acquireRuntime(restoredContext);
  const restoredRuntimeAgain = await __testing.acquireRuntime(restoredContext);

  assert.equal(restoredRuntime, restoredRuntimeAgain);
  assert.equal(__testing.getRuntimeForSession('hist-restore'), restoredRuntime);
});
