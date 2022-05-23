/**
 * Modify from https://github.com/webpack/webpack/blob/main/lib/container/ContainerReferencePlugin.js
 * MIT License http://www.opensource.org/licenses/mit-license.php
 * Author Tobias Koppers @sokra and Zackary Jackson @ScriptedAlchemy
 */
import { META_TYPE } from '@tarojs/helper'
import webpack, { container, NormalModule, RuntimeGlobals } from 'webpack'
import RemoteModule from 'webpack/lib/container/RemoteModule'
import { ConcatSource, RawSource } from 'webpack-sources'

import { addRequireToSource, getIdOrName } from '../../plugins/TaroLoadChunksPlugin'
import type TaroNormalModule from '../../plugins/TaroNormalModule'
import { getChunkEntryModule } from '../../utils/webpack'
import { CollectedDeps, MF_NAME } from '../constant'
import TaroRemoteRuntimeModule from './TaroRemoteRuntimeModule'

const { ContainerReferencePlugin } = container
const ExternalsPlugin = require('webpack/lib/ExternalsPlugin')
const FallbackDependency = require('webpack/lib/container/FallbackDependency')
const FallbackItemDependency = require('webpack/lib/container/FallbackItemDependency')
const FallbackModuleFactory = require('webpack/lib/container/FallbackModuleFactory')
const RemoteToExternalDependency = require('webpack/lib/container/RemoteToExternalDependency')

const PLUGIN_NAME = 'TaroContainerReferencePlugin'
const slashCode = '/'.charCodeAt(0)

export type ContainerReferencePluginOptions = ConstructorParameters<typeof ContainerReferencePlugin>[0]
type MFOptions = Partial<ContainerReferencePluginOptions>

export default class TaroContainerReferencePlugin extends ContainerReferencePlugin {
  private deps: CollectedDeps
  private remoteAssets: Record<'name', string>[]
  private remoteName: string
  private runtimeRequirements: Set<string>

  protected _remoteType?: ContainerReferencePluginOptions['remoteType']
  protected _remotes

  constructor (options: MFOptions, deps: CollectedDeps, remoteAssets: Record<'name', string>[] = [], runtimeRequirements: Set<string>) {
    super(options as ContainerReferencePluginOptions)
    const { remotes = {} } = options
    this.deps = deps
    this.remoteAssets = remoteAssets
    this.remoteName = Object.keys(remotes)[0] || MF_NAME
    this.runtimeRequirements = runtimeRequirements
  }

  apply (compiler: webpack.Compiler) {
    switch (process.env.TARO_ENV) {
      case 'h5':
        this.applyWebApp(compiler)
        break
      default:
        this.applyMiniApp(compiler)
    }
  }

  applyWebApp (compiler: webpack.Compiler) {
    const { _remotes: remotes, _remoteType: remoteType } = this
    const remoteExternals: Record<string, string> = {}
    for (const [key, config] of remotes) {
      let i = 0
      for (const external of config.external) {
        if (external.startsWith('internal ')) continue
        remoteExternals[
          `webpack/container/reference/${key}${i ? `/fallback-${i}` : ''}`
        ] = external
        i++
      }
    }

    new ExternalsPlugin(remoteType, remoteExternals).apply(compiler)

    compiler.hooks.compilation.tap(
      PLUGIN_NAME,
      (compilation, { normalModuleFactory }) => {
        compilation.dependencyFactories.set(RemoteToExternalDependency, normalModuleFactory)
        compilation.dependencyFactories.set(FallbackItemDependency, normalModuleFactory)
        compilation.dependencyFactories.set(FallbackDependency, new FallbackModuleFactory())

        /**
         * 把预编译的依赖改为 Remote module 的形式
         * 例如把 import '@tarojs/taro' 改为 import '[remote]/@tarojs/taro'
         */
        const [key, config] = remotes.find(([key, config]) => key === this.remoteName && config) || { external: [], shareScope: 'default' }
        normalModuleFactory.hooks.factorize.tap(
          PLUGIN_NAME,
          data => {
            if (!data.request.includes('!')) {
              for (const [key, config] of remotes) {
                if (
                  data.request.startsWith(`${key}`) && (data.request.length === key.length || data.request.charCodeAt(key.length) === slashCode)
                ) {
                  return new RemoteModule(
                    data.request,
                    config.external.map((external, i) =>
                      external.startsWith('internal ') ? external.slice(9) : `webpack/container/reference/${key}${i ? `/fallback-${i}` : ''}`
                    ),
                    `.${data.request.slice(key.length)}`,
                    config.shareScope
                  )
                }
              }
              for (const dep of this.deps.keys()) {
                if (data.request === dep || data.request === '@tarojs/runtime') {
                  return new RemoteModule(
                    data.request,
                    config.external.map((external, i) =>
                      external.startsWith('internal ')
                        ? external.slice(9)
                        : `webpack/container/reference/${key}${i ? `/fallback-${i}` : ''}`
                    ),
                    `./${data.request}`,
                    config.shareScope // share scope
                  )
                }
              }
            }
          }
        )

        compilation.hooks.runtimeRequirementInTree
          .for(RuntimeGlobals.ensureChunkHandlers)
          .tap(PLUGIN_NAME, (chunk, set) => {
            set.add(RuntimeGlobals.module)
            set.add(RuntimeGlobals.moduleFactoriesAddOnly)
            set.add(RuntimeGlobals.hasOwnProperty)
            set.add(RuntimeGlobals.initializeSharing)
            set.add(RuntimeGlobals.shareScopeMap)
            compilation.addRuntimeModule(chunk, new TaroRemoteRuntimeModule())
          })
      }
    )
  }

  applyMiniApp (compiler: webpack.Compiler) {
    compiler.hooks.compilation.tap(
      PLUGIN_NAME,
      (compilation, { normalModuleFactory }) => {
        /**
         * 把预编译的依赖改为 Remote module 的形式
         * 例如把 import '@tarojs/taro' 改为 import '[remote]/@tarojs/taro'
         */
        const [key, config] = this._remotes.find(([key, config]) => key === this.remoteName && config) || { external: [], shareScope: 'default' }
        normalModuleFactory.hooks.factorize.tap(
          PLUGIN_NAME,
          data => {
            if (!data.request.includes('!')) {
              for (const dep of this.deps.keys()) {
                if (data.request === dep || data.request === '@tarojs/runtime') {
                  return new RemoteModule(
                    data.request,
                    config.external.map((external, i) =>
                      external.startsWith('internal ')
                        ? external.slice(9)
                        : `webpack/container/reference/${key}${i ? `/fallback-${i}` : ''}`
                    ),
                    `./${data.request}`,
                    config.shareScope // share scope
                  )
                }
              }
            }
          }
        )

        /**
         * 修改 webpack runtime
         *   1. 注入一些 webpack 内置的工具函数（remote 打包时注入了，而 host 里没有，需要补全，后续改为自动补全）
         *   2. 修改 webpack/runtime/remotes 模块的输出
         *     a) 生成 id 映射对象 idToExternalAndNameMapping
         *     b) 插入自动注册模块的逻辑
         */
        compilation.hooks.additionalTreeRuntimeRequirements.tap(
          PLUGIN_NAME,
          (chunk, set) => {
            // webpack runtime 增加 Remote runtime 使用到的工具函数
            this.runtimeRequirements.forEach(item => set.add(item))
            compilation.addRuntimeModule(chunk, new TaroRemoteRuntimeModule())
          }
        )

        /**
         * 在 dist/app.js 头部注入 require，
         * 依赖所有的预编译 chunk 和 remoteEntry
         */
        const hooks = webpack.javascript.JavascriptModulesPlugin.getCompilationHooks(compilation)
        hooks.render.tap(
          PLUGIN_NAME,
          (modules: ConcatSource, { chunk }) => {
            const chunkEntryModule = getChunkEntryModule(compilation, chunk) as any
            if (chunkEntryModule) {
              const entryModule: TaroNormalModule = chunkEntryModule.rootModule ?? chunkEntryModule
              if (entryModule.miniType === META_TYPE.ENTRY) {
                return addRequireToSource(getIdOrName(chunk), modules, this.remoteAssets)
              }
              return modules
            } else {
              return modules
            }
          }
        )

        /**
         * 模块 "webpack/container/reference/[remote]" 用于网络加载 remoteEntry.js，
         * 在小程序环境则不需要了，因此将模块输出改为空字符串，减少不必要的代码
         */
        hooks.renderModuleContent.tap(
          PLUGIN_NAME,
          (source, module: NormalModule) => {
            if (module.userRequest === `webpack/container/reference/${this.remoteName}`) {
              return new RawSource('')
            }
            return source
          }
        )
      }
    )
  }
}
