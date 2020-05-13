/**
 * Copyright 2004-present Facebook. All Rights Reserved.
 *
 * Returns an atom, the basic unit of state in Recoil. An atom is a reference to
 * value that can be read, written, and subscribed to. It has a `key` that is
 * stable across time so that it can be persisted.
 *
 * There are two required options for creating an atom:
 *
 *    key. This is a string that uniquely identifies the atom. It should be
 *         stable across time so that persisted states remain valid.
 *
 *    default
 *          If `default` is provided, the atom is initialized to that value.
 *          Or, it may be set to another RecoilValue to use as a fallback.
 *          In that case, the value of the atom will be equal to that of the
 *          fallback, and will remain so until the first time the atom is written
 *          to, at which point it will stop tracking the fallback RecoilValue.
 *
 * The `persistence` option specifies that the atom should be saved to storage.
 * It is an object with two properties: `type` specifies where the atom should
 * be persisted; its only allowed value is "url"; `backButton` specifies whether
 * changes to the atom should result in pushes to the browser history stack; if
 * true, changing the atom and then hitting the Back button will cause the atom's
 * previous value to be restored. Applications are responsible for implementing
 * persistence by using the `useTransactionObservation` hook.
 *
 * The scopeRules_APPEND_ONLY_READ_THE_DOCS option causes the atom be be "scoped".
 * A scoped atom's value depends on other parts of the application state.
 * A separate value of the atom is stored for every value of the state that it
 * depends on. The dependencies may be changed without breaking existing URLs --
 * it uses whatever rule was current when the URL was written. Values written
 * under the newer rules are overlaid atop the previously-written values just for
 * those states in which the write occured, with reads falling back to the older
 * values in other states, and eventually to the default or fallback.
 *
 * The scopedRules_APPEND_ONLY_READ_THE_DOCS parameter is a list of rules;
 * it should start with a single entry. This list must only be appended to:
 * existing entries must never be deleted or modified. Each rule is an atom
 * or selector whose value is some arbitrary key. A different value of the
 * scoped atom will be stored for each key. To change the scope rule, simply add
 * a new function to the list. Each rule is either an array of atoms of primitives,
 * or an atom of an array of primitives.
 *
 * Ordinary atoms may be upgraded to scoped atoms. To un-scope an atom, add a new
 * scope rule consisting of a constant.
 *
 * @emails oncall+perf_viz
 * @flow strict-local
 * @format
 */
'use strict';

import type {Loadable} from 'Recoil_Loadable';
import type {RecoilState, RecoilValue} from 'Recoil_RecoilValue';
import type {ScopeRules} from 'Recoil_ScopedAtom';
import type {NodeKey, TreeState} from 'Recoil_State';

const atomWithFallback = require('Recoil_atomWithFallback');
const {
  mapByDeletingFromMap,
  mapBySettingInMap,
  setByAddingToSet,
} = require('Recoil_CopyOnWrite');
const deepFreezeValue = require('Recoil_deepFreezeValue');
const expectationViolation = require('Recoil_expectationViolation');
const isPromise = require('Recoil_isPromise');
const {loadableWithValue} = require('Recoil_Loadable');
const {DEFAULT_VALUE, DefaultValue, registerNode} = require('Recoil_Node');
const nullthrows = require('Recoil_nullthrows');
const {isRecoilValue} = require('Recoil_RecoilValue');
const {scopedAtom} = require('Recoil_ScopedAtom');

// It would be nice if this didn't have to be defined at the Recoil level, but I don't want to make
// the api cumbersome. One way to do this would be to have a selector mark the atom as persisted.
// Note that this should also allow for special URL handling. (Although the persistence observer could
// have this as a separate configuration.)
export type PersistenceType = 'none' | 'url';
export type PersistenceInfo = $ReadOnly<{
  type: PersistenceType,
  backButton?: boolean,
}>;
export type PersistenceSettings<Stored> = $ReadOnly<{
  ...PersistenceInfo,
  validator: (mixed, DefaultValue) => Stored | DefaultValue,
}>;

export type AtomOptions<T> = $ReadOnly<{
  key: NodeKey,
  default: RecoilValue<T> | Promise<T> | T,
  persistence_UNSTABLE?: PersistenceSettings<T>,
  scopeRules_APPEND_ONLY_READ_THE_DOCS?: ScopeRules,
  dangerouslyAllowMutability?: boolean,
}>;

type BaseAtomOptions<T> = $ReadOnly<{
  ...AtomOptions<T>,
  default: T,
}>;

function baseAtom<T>(options: BaseAtomOptions<T>): RecoilState<T> {
  const {key, persistence_UNSTABLE: persistence} = options;
  return registerNode({
    key,
    options,

    get: (_store, state: TreeState): [TreeState, Loadable<T>] => {
      if (state.atomValues.has(key)) {
        // atom value is stored in state
        return [state, nullthrows(state.atomValues.get(key))];
      } else if (state.nonvalidatedAtoms.has(key)) {
        if (persistence == null) {
          expectationViolation(
            `Tried to restore a persisted value for atom ${key} but it has no persistence settings.`,
          );
          return [state, loadableWithValue(options.default)];
        }
        const nonvalidatedValue = state.nonvalidatedAtoms.get(key);
        const validatedValue: T | DefaultValue = persistence.validator(
          nonvalidatedValue,
          DEFAULT_VALUE,
        );

        return validatedValue instanceof DefaultValue
          ? [
              {
                ...state,
                nonvalidatedAtoms: mapByDeletingFromMap(
                  state.nonvalidatedAtoms,
                  key,
                ),
              },
              loadableWithValue(options.default),
            ]
          : [
              {
                ...state,
                atomValues: mapBySettingInMap(
                  state.atomValues,
                  key,
                  loadableWithValue(validatedValue),
                ),
                nonvalidatedAtoms: mapByDeletingFromMap(
                  state.nonvalidatedAtoms,
                  key,
                ),
              },
              loadableWithValue(validatedValue),
            ];
      } else {
        return [state, loadableWithValue(options.default)];
      }
    },

    set: (
      _store,
      state: TreeState,
      newValue: T | DefaultValue,
    ): [TreeState, $ReadOnlySet<NodeKey>] => {
      if (options.dangerouslyAllowMutability !== true) {
        deepFreezeValue(newValue);
      }
      return [
        {
          ...state,
          dirtyAtoms: setByAddingToSet(state.dirtyAtoms, key),
          atomValues:
            newValue instanceof DefaultValue
              ? mapByDeletingFromMap(state.atomValues, key)
              : mapBySettingInMap(
                  state.atomValues,
                  key,
                  loadableWithValue(newValue),
                ),
          nonvalidatedAtoms: mapByDeletingFromMap(state.nonvalidatedAtoms, key),
        },
        new Set([key]),
      ];
    },
  });
}

function atom<T>(options: AtomOptions<T>): RecoilState<T> {
  const {
    default: optionsDefault,
    scopeRules_APPEND_ONLY_READ_THE_DOCS,
    ...restOptions
  } = options;
  if (isRecoilValue(optionsDefault) || isPromise(optionsDefault)) {
    return atomWithFallback<T>({
      ...restOptions,
      default: optionsDefault,
      scopeRules_APPEND_ONLY_READ_THE_DOCS,
    });
  } else if (scopeRules_APPEND_ONLY_READ_THE_DOCS) {
    return scopedAtom<T>({
      ...restOptions,
      default: optionsDefault,
      scopeRules_APPEND_ONLY_READ_THE_DOCS,
    });
  } else {
    return baseAtom<T>({...restOptions, default: optionsDefault});
  }
}

module.exports = atom;