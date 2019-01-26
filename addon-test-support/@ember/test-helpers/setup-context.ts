import { run } from '@ember/runloop';
import { set, setProperties, get, getProperties } from '@ember/object';
import { guidFor } from '@ember/object/internals';
import Resolver from '@ember/application/resolver';

import buildOwner, { Owner } from './build-owner';
import { _setupAJAXHooks } from './settled';
import Ember from 'ember';
import { Promise } from 'rsvp';
import { assert } from '@ember/debug';
import global from './global';
import { getResolver } from './resolver';
import { getApplication } from './application';
import { nextTickPromise } from './-utils';

export interface BaseContext {
  [key: string]: any;
}

export interface TestContext extends BaseContext {
  owner: Owner;

  set(key: string, value: any): any;
  setProperties(hash: { [key: string]: any }): { [key: string]: any };
  get(key: string): any;
  getProperties(...args: string[]): Pick<BaseContext, string>;

  pauseTest(): Promise<void>;
  resumeTest(): Promise<void>;
}

// eslint-disable-next-line require-jsdoc
export function isTestContext(context: BaseContext): context is TestContext {
  return typeof context.pauseTest === 'function' && typeof context.resumeTest === 'function';
}

let __test_context__: BaseContext | undefined;

/**
  Stores the provided context as the "global testing context".

  Generally setup automatically by `setupContext`.

  @public
  @param {Object} context the context to use
*/
export function setContext(context: BaseContext): void {
  __test_context__ = context;
}

/**
  Retrive the "global testing context" as stored by `setContext`.

  @public
  @returns {Object} the previously stored testing context
*/
export function getContext(): BaseContext | undefined {
  return __test_context__;
}

/**
  Clear the "global testing context".

  Generally invoked from `teardownContext`.

  @public
*/
export function unsetContext(): void {
  __test_context__ = undefined;
}

/**
 * Returns a promise to be used to pauses the current test (due to being
 * returned from the test itself).  This is useful for debugging while testing
 * or for test-driving.  It allows you to inspect the state of your application
 * at any point.
 *
 * The test framework wrapper (e.g. `ember-qunit` or `ember-mocha`) should
 * ensure that when `pauseTest()` is used, any framework specific test timeouts
 * are disabled.
 *
 * @public
 * @returns {Promise<void>} resolves _only_ when `resumeTest()` is invoked
 * @example <caption>Usage via ember-qunit</caption>
 *
 * import { setupRenderingTest } from 'ember-qunit';
 * import { render, click, pauseTest } from '@ember/test-helpers';
 *
 *
 * module('awesome-sauce', function(hooks) {
 *   setupRenderingTest(hooks);
 *
 *   test('does something awesome', async function(assert) {
 *     await render(hbs`{{awesome-sauce}}`);
 *
 *     // added here to visualize / interact with the DOM prior
 *     // to the interaction below
 *     await pauseTest();
 *
 *     click('.some-selector');
 *
 *     assert.equal(this.element.textContent, 'this sauce is awesome!');
 *   });
 * });
 */
export function pauseTest(): Promise<void> {
  let context = getContext();

  if (!context || !isTestContext(context)) {
    throw new Error(
      'Cannot call `pauseTest` without having first called `setupTest` or `setupRenderingTest`.'
    );
  }

  return context.pauseTest();
}

/**
  Resumes a test previously paused by `await pauseTest()`.

  @public
*/
export function resumeTest(): void {
  let context = getContext();

  if (!context || !isTestContext(context)) {
    throw new Error(
      'Cannot call `resumeTest` without having first called `setupTest` or `setupRenderingTest`.'
    );
  }

  context.resumeTest();
}

const ORIGINAL_EMBER_ONERROR: (error: Error) => void | undefined = Ember.onerror;

/**
  Sets the Ember.onerror function for the duration of a single test. This
  value is reset after each test to ensure correct test isolation.

  @public
  @param {Function} onError the onError function to be set on Ember.onerror
*/
export function setupOnerror(onError: (error: Error) => void): void {
  let context = getContext();
  let contextGuid = guidFor(context);
  let contextCleanup = CLEANUP[contextGuid];

  if (!Array.isArray(contextCleanup)) {
    throw new Error(
      'You must use `setupContext` / `setupRenderingContext` / `setupApplicationContext` in order to use `setupOnerror`'
    );
  }

  Ember.onerror = onError;
}

export const CLEANUP = Object.create(null);

/**
  Used by test framework addons to setup the provided context for testing.

  Responsible for:

  - sets the "global testing context" to the provided context (`setContext`)
  - create an owner object and set it on the provided context (e.g. `this.owner`)
  - setup `this.set`, `this.setProperties`, `this.get`, and `this.getProperties` to the provided context
  - setting up AJAX listeners
  - setting up `pauseTest` (also available as `this.pauseTest()`) and `resumeTest` helpers

  @public
  @param {Object} context the context to setup
  @param {Object} [options] options used to override defaults
  @param {Resolver} [options.resolver] a resolver to use for customizing normal resolution
  @returns {Promise<Object>} resolves with the context that was setup
*/
export default function setupContext(
  context: BaseContext,
  options: { resolver?: Resolver } = {}
): Promise<TestContext> {
  (Ember as any).testing = true;
  setContext(context);

  let contextGuid = guidFor(context);
  CLEANUP[contextGuid] = [];

  return nextTickPromise()
    .then(() => {
      let application = getApplication();
      if (application) {
        return application.boot().then(() => {});
      }
      return;
    })
    .then(() => {
      let testElementContainer = document.getElementById('ember-testing-container')!; // TODO remove "!"
      let fixtureResetValue = testElementContainer.innerHTML;

      // push this into the final cleanup bucket, to be ran _after_ the owner
      // is destroyed and settled (e.g. flushed run loops, etc)
      CLEANUP[contextGuid].push(() => {
        testElementContainer.innerHTML = fixtureResetValue;
      });

      let { resolver } = options;

      // This handles precendence, specifying a specific option of
      // resolver always trumps whatever is auto-detected, then we fallback to
      // the suite-wide registrations
      //
      // At some later time this can be extended to support specifying a custom
      // engine or application...
      if (resolver) {
        return buildOwner(null, resolver);
      }

      return buildOwner(getApplication(), getResolver());
    })
    .then(owner => {
      Object.defineProperty(context, 'owner', {
        configurable: true,
        enumerable: true,
        value: owner,
        writable: false,
      });

      Object.defineProperty(context, 'set', {
        configurable: true,
        enumerable: true,
        value(key: string, value: any): any {
          let ret = run(function() {
            return set(context, key, value);
          });

          return ret;
        },
        writable: false,
      });

      Object.defineProperty(context, 'setProperties', {
        configurable: true,
        enumerable: true,
        value(hash: { [key: string]: any }): { [key: string]: any } {
          let ret = run(function() {
            return setProperties(context, hash);
          });

          return ret;
        },
        writable: false,
      });

      Object.defineProperty(context, 'get', {
        configurable: true,
        enumerable: true,
        value(key: string): any {
          return get(context, key);
        },
        writable: false,
      });

      Object.defineProperty(context, 'getProperties', {
        configurable: true,
        enumerable: true,
        value(...args: string[]): Pick<BaseContext, string> {
          return getProperties(context, args);
        },
        writable: false,
      });

      let resume: Function | undefined;
      context.resumeTest = function resumeTest() {
        assert('Testing has not been paused. There is nothing to resume.', Boolean(resume));
        (resume as Function)();
        global.resumeTest = resume = undefined;
      };

      context.pauseTest = function pauseTest() {
        console.info('Testing paused. Use `resumeTest()` to continue.'); // eslint-disable-line no-console

        return new Promise(resolve => {
          resume = resolve;
          global.resumeTest = resumeTest;
        }, 'TestAdapter paused promise');
      };

      CLEANUP[contextGuid].push(() => {
        Ember.onerror = ORIGINAL_EMBER_ONERROR;
      });

      _setupAJAXHooks();

      return context as TestContext;
    });
}
