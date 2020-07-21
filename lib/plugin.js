// @ts-check

/**
 * Provides a way to load "plugins" as provided by the user.
 *
 * Currently supports:
 *
 * - Root hooks
 * - Global fixtures (setup/teardown)
 *
 * @module plugin
 * @private
 */

'use strict';

const {createUnsupportedError} = require('./errors');
const {castArray} = require('./utils');

const createFunctionArrayValidator = pluginType => value => {
  let isValid = true;
  if (Array.isArray(value)) {
    if (value.some(item => typeof item !== 'function')) {
      isValid = false;
    }
  } else if (typeof value !== 'function') {
    isValid = false;
  }
  if (!isValid) {
    throw createUnsupportedError(
      `${pluginType} must be a function or an array of functions`
    );
  }
};

/**
 * @type {Set<PluginDefinition>}
 */
const MochaPlugins = new Set([
  {
    exportName: 'mochaHooks',
    optionName: 'rootHooks',
    validate(value) {
      if (
        Array.isArray(value) ||
        (typeof value !== 'function' && typeof value !== 'object')
      ) {
        throw createUnsupportedError(
          `mochaHooks must be an object or a function returning (or fulfilling with) an object`
        );
      }
    },
    async finalize(rootHooks) {
      if (rootHooks.length) {
        const rootHookObjects = await Promise.all(
          rootHooks.map(async hook =>
            typeof hook === 'function' ? hook() : hook
          )
        );

        return rootHookObjects.reduce(
          (acc, hook) => {
            hook = {
              beforeAll: [],
              beforeEach: [],
              afterAll: [],
              afterEach: [],
              ...hook
            };
            return {
              beforeAll: [...acc.beforeAll, ...castArray(hook.beforeAll)],
              beforeEach: [...acc.beforeEach, ...castArray(hook.beforeEach)],
              afterAll: [...acc.afterAll, ...castArray(hook.afterAll)],
              afterEach: [...acc.afterEach, ...castArray(hook.afterEach)]
            };
          },
          {beforeAll: [], beforeEach: [], afterAll: [], afterEach: []}
        );
      }
    }
  },
  {
    exportName: 'mochaGlobalSetup',
    optionName: 'globalSetup',
    validate: createFunctionArrayValidator('mochaGlobalSetup')
  },
  {
    exportName: 'mochaGlobalTeardown',
    optionName: 'globalTeardown',
    validate: createFunctionArrayValidator('mochaGlobalTeardown')
  }
]);

/**
 * Loads plugins; {@link PluginLoader#load} should be called for all required
 * modules, and finally the result of {@link PluginLoader#finalize} should be
 * handed as options to the `Mocha` constructor.
 */
exports.PluginLoader = class PluginLoader {
  /**
   * Initializes plugin names, plugin map, etc.
   * @param {PluginDefinition[]|Set<PluginDefinition>} pluginDefinitions - Plugin definitions
   */
  constructor(pluginDefinitions = MochaPlugins) {
    this.registered = new Map();

    pluginDefinitions.forEach(pluginDef => {
      this.register(pluginDef);
    });

    this.loaded = new Map(this.exportNames.map(name => [name, []]));
  }

  register(plugin) {
    if (this.registered.has(plugin.exportName)) {
      throw new Error(`plugin name conflict: ${plugin.exportName}`);
    }
    this.registered.set(plugin.exportName, plugin);
  }

  get exportNames() {
    return Array.from(this.registered).map(([key]) => key);
  }

  load(requiredModule) {
    // we should explicitly NOT fail if other stuff is exported.
    // we only care about the plugins we know about.
    if (requiredModule && typeof requiredModule === 'object') {
      return this.exportNames.reduce((isFound, pluginName) => {
        const impl = requiredModule[pluginName];
        if (impl) {
          const plugin = this.registered.get(pluginName);
          if (plugin.validate) {
            plugin.validate(impl);
          }
          this.loaded.set(pluginName, [
            ...this.loaded.get(pluginName),
            ...castArray(impl)
          ]);
          return true;
        }
        return isFound;
      }, false);
    }
    return false;
  }

  async finalize() {
    const finalizedPlugins = Object.create(null);

    for await (const [exportName, impls] of this.loaded.entries()) {
      if (impls.length) {
        const plugin = this.registered.get(exportName);
        if (typeof plugin.finalize === 'function') {
          finalizedPlugins[
            plugin.optionName || exportName
          ] = await plugin.finalize(impls);
        }
      }
    }

    return finalizedPlugins;
  }

  /**
   * Constructs a {@link PluginLoader}
   * @param {PluginDefinition[]|Set<PluginDefinition>} [pluginDefs] - Plugin definitions
   */
  static create(pluginDefs = MochaPlugins) {
    return new PluginLoader(pluginDefs);
  }
};

/**
 * An object making up all necessary parts of a plugin loader and aggregator
 * @typedef {Object} PluginDefinition
 * @property {string} exportName - Named export to use
 * @property {string} [optionName] - Option name for Mocha constructor (use `exportName` if omitted)
 * @property {PluginValidator} [validate] - Validator function
 * @property {PluginFinalizer} [finalize] - Finalizer/aggregator function
 */

/**
 * A map of constants to (typically) `string` values.
 *
 * **Not** a `Map`.
 * @template T
 * @typedef {{[key: string]: T}} ConstantMap
 * @readonly
 */

/**
 * A function to validate a user-supplied plugin implementation
 * @callback PluginValidator
 * @param {*} value - Value to check
 * @returns {void}
 */

/**
 * A function to finalize plugins impls of a particular ilk
 * @callback PluginFinalizer
 * @param {Array<*>} impls - User-supplied implementations
 * @returns {Promise<*>|*}
 */
