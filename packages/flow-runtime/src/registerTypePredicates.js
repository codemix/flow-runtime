/* @flow */

import type TypeContext from './TypeContext';

export default function registerTypePredicates (context: TypeContext) {
  // TODO: make better subtyping rules
  context.setPredicate('$ReadOnlyArray', (input: any) => Array.isArray(input) && Object.isFrozen(input));
  context.setPredicate('Array', (input: any) => Array.isArray(input));
  context.setPredicate('Map', (input: any) => input instanceof Map);
  context.setPredicate('Set', (input: any) => input instanceof Set);
  context.setPredicate('Promise', (input: any) => {
    if (input instanceof Promise) {
      return true;
    } else {
      return input !== null
        && (typeof input === 'object' || typeof input === 'function')
        && typeof input.then === 'function'
        ;
    }
  });
}
