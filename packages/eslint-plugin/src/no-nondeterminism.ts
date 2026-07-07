import { ESLintUtils, type TSESTree } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/DavideCarvalho/adonis-durable/tree/main/packages/eslint-plugin#${name}`,
);

type MessageId = 'useNow' | 'useRandom' | 'useUuid' | 'useNowDate';

/**
 * A function/arrow passed as an argument to a CHECKPOINT-CALLBACK primitive — `ctx.localStep(...)`,
 * `ctx.task(...)` or `ctx.sideEffect(...)` — whose body is run once and checkpointed, so
 * non-determinism inside it is fine (only the orchestration body must be pure). NOTE: `ctx.step` is
 * NOT here — it is now the always-DISPATCHED step (its 2nd arg is data, not a callback), so a
 * function reaching it is not a checkpointed body and the walk should not stop at it.
 */
function isCheckpointedCallback(fn: TSESTree.Node): boolean {
  const call = fn.parent;
  if (call?.type !== 'CallExpression' || !call.arguments.includes(fn as never)) return false;
  const callee = call.callee;
  return (
    callee.type === 'MemberExpression' &&
    callee.property.type === 'Identifier' &&
    (callee.property.name === 'localStep' ||
      callee.property.name === 'task' ||
      callee.property.name === 'sideEffect')
  );
}

/** The receiver looks like a workflow engine — `engine` / `workflowEngine` / `this.engine` etc. So
 *  `engine.register(...)` is recognized but an unrelated `someRegistry.register(...)` is not. */
function isEngineReceiver(object: TSESTree.Expression | TSESTree.Super): boolean {
  const name =
    object.type === 'Identifier'
      ? object.name
      : object.type === 'MemberExpression' && object.property.type === 'Identifier'
        ? object.property.name
        : undefined;
  return name !== undefined && /engine/i.test(name);
}

/**
 * True for the workflow body function passed to `engine.register(name, version, fn)` (or
 * `registerRemote`/`registerEntity`) — Agora's function form of a workflow. The deterministic
 * orchestration body is the function/arrow argument of that call, and the receiver must read as a
 * workflow engine, so non-determinism inside it must be flagged (while an unrelated `.register` on
 * some other object is left alone).
 */
function isRegisterWorkflowBody(fn: TSESTree.Node): boolean {
  const call = fn.parent;
  if (call?.type !== 'CallExpression' || !call.arguments.includes(fn as never)) return false;
  const callee = call.callee;
  return (
    callee.type === 'MemberExpression' &&
    callee.property.type === 'Identifier' &&
    (callee.property.name === 'register' ||
      callee.property.name === 'registerRemote' ||
      callee.property.name === 'registerEntity') &&
    isEngineReceiver(callee.object)
  );
}

/** True when the class `node` decorates a method `run` and carries the `@Workflow` decorator. */
function isWorkflowDecoratedClass(classNode: TSESTree.Node | undefined): boolean {
  if (
    !classNode ||
    (classNode.type !== 'ClassDeclaration' && classNode.type !== 'ClassExpression')
  ) {
    return false;
  }
  return (classNode.decorators ?? []).some((d) => {
    const e = d.expression;
    if (e.type === 'Identifier') return e.name === 'Workflow';
    if (e.type === 'CallExpression' && e.callee.type === 'Identifier') {
      return e.callee.name === 'Workflow';
    }
    return false;
  });
}

/**
 * True when `node` sits lexically inside a workflow's deterministic orchestration body — either the
 * `run` method of a class decorated with `@Workflow`, or the function passed to `engine.register(...)`.
 * Returns false the moment the walk crosses a `ctx.step`/`ctx.task` callback boundary, since that body
 * is checkpointed (run once) and so may be non-deterministic.
 */
function isInWorkflowBody(node: TSESTree.Node): boolean {
  let cur: TSESTree.Node | undefined = node;
  while (cur) {
    if (cur.type === 'ArrowFunctionExpression' || cur.type === 'FunctionExpression') {
      // Crossing a `ctx.step`/`ctx.task` callback boundary means the call is inside a checkpointed
      // step — not the deterministic orchestration body — so don't flag it.
      if (isCheckpointedCallback(cur)) return false;
      // The function form: the body passed to `engine.register(name, version, fn)`.
      if (isRegisterWorkflowBody(cur)) return true;
    }
    // The class form: the `run` method of a `@Workflow`-decorated class.
    if (
      cur.type === 'MethodDefinition' &&
      cur.key.type === 'Identifier' &&
      cur.key.name === 'run' &&
      isWorkflowDecoratedClass(cur.parent?.parent) // MethodDefinition → ClassBody → Class
    ) {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}

/** The receiver name of a member call: `crypto` for `crypto.x()` and `globalThis.crypto.x()`. */
function receiverName(object: TSESTree.Expression | TSESTree.Super): string | undefined {
  if (object.type === 'Identifier') return object.name;
  if (object.type === 'MemberExpression' && object.property.type === 'Identifier') {
    return object.property.name;
  }
  return undefined;
}

export const noNondeterminism = createRule<[], MessageId>({
  name: 'no-nondeterminism',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow non-deterministic sources (Date.now, Math.random, new Date, crypto.randomUUID) inside a durable workflow body — they differ across replays and silently corrupt a durable run. Use ctx.now() for a timestamp or ctx.sideEffect(() => …) to capture any other generated value once.',
    },
    messages: {
      useNow:
        'Non-deterministic `{{call}}` inside a durable workflow body — use `ctx.now()` (recorded once, then replayed).',
      useRandom:
        'Non-deterministic `Math.random()` inside a durable workflow body — use `ctx.sideEffect(() => Math.random())` (captured once, then replayed).',
      useUuid:
        'Non-deterministic `crypto.randomUUID()` inside a durable workflow body — use `ctx.sideEffect(() => crypto.randomUUID())` (captured once, then replayed).',
      useNowDate:
        'Non-deterministic `new Date()` inside a durable workflow body — use `new Date(await ctx.now())`.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.property.type !== 'Identifier') return;
        const prop = callee.property.name;
        const obj = receiverName(callee.object);
        const isBanned =
          ((obj === 'Date' || obj === 'performance') && prop === 'now') ||
          (obj === 'Math' && prop === 'random') ||
          (obj === 'crypto' && prop === 'randomUUID');
        if (!isBanned || !isInWorkflowBody(node)) return;
        if (prop === 'random') context.report({ node, messageId: 'useRandom' });
        else if (prop === 'randomUUID') context.report({ node, messageId: 'useUuid' });
        else context.report({ node, messageId: 'useNow', data: { call: `${obj}.now()` } });
      },
      NewExpression(node) {
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'Date' &&
          node.arguments.length === 0 &&
          isInWorkflowBody(node)
        ) {
          context.report({ node, messageId: 'useNowDate' });
        }
      },
    };
  },
});
