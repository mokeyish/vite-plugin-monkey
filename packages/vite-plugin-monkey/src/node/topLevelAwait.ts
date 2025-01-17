import type { Node as AcornNode } from 'acorn';
import * as acornWalk from 'acorn-walk';
import MagicString from 'magic-string';
import type { OutputAsset, OutputChunk, PluginContext } from 'rollup';

type CallAcornNode = AcornNode & {
  callee: AcornNode & { name: string };
  arguments: AcornNode[];
};

const awaitOffset = `await`.length;
const tlaIdentifier = `__TOP_LEVEL_AWAIT__`;

export const transformTlaToIdentifier = (
  context: PluginContext,
  chunk: OutputAsset | OutputChunk,
) => {
  if (chunk.type == 'chunk') {
    const code = chunk.code;
    if (!code.includes(`await`)) {
      return;
    }
    const ast = context.parse(code);
    const tlaNodes: AcornNode[] = [];
    const tlaForOfNodes: AcornNode[] = [];
    acornWalk.simple(
      ast,
      {
        AwaitExpression(node) {
          // top level await
          tlaNodes.push(node);
        },
        // @ts-ignore
        ForOfStatement(node: AcornNode & { await: boolean }) {
          if (node.await === true) {
            tlaForOfNodes.push(node);
          }
        },
      },
      { ...acornWalk.base, Function: () => {} },
    );
    if (tlaNodes.length > 0 || tlaForOfNodes.length > 0) {
      const ms = new MagicString(code);
      tlaNodes.forEach((node) => {
        // await xxx -> await (xxx)
        ms.appendLeft(node.start + awaitOffset, `(`);
        ms.appendRight(node.end, `)`);

        // await (xxx) -> __topLevelAwait__ (xxx)
        ms.update(node.start, node.start + awaitOffset, tlaIdentifier);
      });
      tlaForOfNodes.forEach((node) => {
        // for await(const x of xxx){} -> __topLevelAwait__ ((async()=>{ /*start*/for await(const x of xxx){}/*end*/  })());
        ms.appendLeft(node.start, `${tlaIdentifier}((async()=>{`);
        ms.appendRight(node.end, `})());`);
      });
      return {
        code: ms.toString(),
        map: ms.generateMap(),
      };
    }
  }
};

export const transformIdentifierToTla = (
  context: PluginContext,
  chunk: OutputAsset | OutputChunk,
) => {
  if (chunk.type == 'chunk') {
    if (!chunk.code.includes(tlaIdentifier)) {
      return;
    }

    const base = Object.keys(acornWalk.base).reduce<
      Record<string, acornWalk.RecursiveWalkerFn<any>>
    >((p, key) => {
      if (key in p) return p;
      p[key] = (node, state, callback) => {
        if (
          chunk.code.substring(node.start, node.end).includes(tlaIdentifier)
        ) {
          return acornWalk.base[key](node, state, callback);
        }
      };
      return p;
    }, {});
    const ast = context.parse(chunk.code);
    const tlaCallNodes: CallAcornNode[] = [];
    const topFnNodes: AcornNode[] = [];
    acornWalk.simple(
      ast,
      {
        // @ts-ignore
        CallExpression(node: CallAcornNode) {
          // top level await
          if (
            node.callee?.type === `Identifier` &&
            node.callee?.name === tlaIdentifier
          ) {
            tlaCallNodes.push(node);
          }
        },
      },
      {
        ...base,
        Function: (node, state, callback) => {
          if (topFnNodes.length == 0) {
            topFnNodes.push(node);
          }
          if (
            chunk.code.substring(node.start, node.end).includes(tlaIdentifier)
          ) {
            return acornWalk.base.Function(node, state, callback);
          }
        },
      },
    );
    if (tlaCallNodes.length > 0 || topFnNodes.length > 0) {
      const ms = new MagicString(chunk.code, {});
      tlaCallNodes.forEach((node) => {
        const callee = node.callee;
        const [argument] = node.arguments as AcornNode[];
        ms.update(callee.start, callee.end, '');
        ms.update(callee.end, argument.start, `(await\x20`);
      });
      topFnNodes.forEach((node) => {
        ms.appendLeft(node.start, `async\x20`);
      });
      chunk.code = ms.toString();
      // TODO sourcemap
      // https://github.com/keik/merge-source-map
      if (chunk.map) {
        chunk.map;
      }
    }
  }
};
