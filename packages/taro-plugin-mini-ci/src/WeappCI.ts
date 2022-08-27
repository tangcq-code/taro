/* eslint-disable no-console */
import * as cp from 'child_process'
import * as crypto from 'crypto'
import ci, { Project }from 'miniprogram-ci'
import { ICreateProjectOptions } from 'miniprogram-ci/dist/@types/ci/project'
import * as os from 'os'
import * as path from 'path'

import BaseCI from './BaseCi'
import { generateQrcodeImageFile, printQrcode2Terminal, readQrcodeImageContent } from './utils/qrcode'

export default class WeappCI extends BaseCI {
  private instance: Project
  /** 微信开发者安装路径 */
  private devToolsInstallPath: string

  _init () {
    const { outputPath, appPath } = this.ctx.paths
    const { fs } = this.ctx.helper
    if (this.pluginOpts.weapp == null) {
      throw new Error('请为"@tarojs/plugin-mini-ci"插件配置 "weapp" 选项')
    }
    this.devToolsInstallPath = this.pluginOpts.weapp.devToolsInstallPath || (process.platform === 'darwin' ? '/Applications/wechatwebdevtools.app' : 'C:\\Program Files (x86)\\Tencent\\微信web开发者工具')
    delete this.pluginOpts.weapp.devToolsInstallPath

    const weappConfig: ICreateProjectOptions = {
      type: 'miniProgram',
      projectPath: outputPath,
      appid: this.pluginOpts.weapp!.appid,
      privateKeyPath: this.pluginOpts.weapp!.privateKeyPath,
      ignores: this.pluginOpts.weapp!.ignores,
    }
    const privateKeyPath = path.isAbsolute(weappConfig.privateKeyPath!) ? weappConfig.privateKeyPath : path.join(appPath, weappConfig.privateKeyPath!)
    if (!fs.pathExistsSync(privateKeyPath)) {
      throw new Error(`"weapp.privateKeyPath"选项配置的路径不存在,本次上传终止:${privateKeyPath}`)
    }
    this.instance = new ci.Project(weappConfig)
  }

  async open () {
    const { fs, printLog, processTypeEnum, getUserHomeDir } = this.ctx.helper
    const { appPath } = this.ctx.paths
    // 检查安装路径是否存在
    if (!(await fs.pathExists(this.devToolsInstallPath))) {
      printLog(processTypeEnum.ERROR, '微信开发者工具安装路径不存在', this.devToolsInstallPath)
      return
    }
    /** 命令行工具所在路径 */
    const cliPath = path.join(this.devToolsInstallPath, os.platform() === 'win32' ? '/cli.bat' : '/Contents/MacOS/cli')
    const isWindows = os.platform() === 'win32'

    // 检查是否开启了命令行
    const errMesg = '工具的服务端口已关闭。要使用命令行调用工具，请打开工具 -> 设置 -> 安全设置，将服务端口开启。详细信息: https://developers.weixin.qq.com/miniprogram/dev/devtools/cli.html'
    const installPath = isWindows ? this.devToolsInstallPath : `${this.devToolsInstallPath}/Contents/MacOS`
    const md5 = crypto.createHash('md5').update(installPath).digest('hex')
    const ideStatusFile = path.join(
      getUserHomeDir(),
      isWindows
        ? `/AppData/Local/微信开发者工具/User Data/${md5}/Default/.ide-status`
        : `/Library/Application Support/微信开发者工具/${md5}/Default/.ide-status`
    )
    if (!(await fs.pathExists(ideStatusFile))) {
      printLog(processTypeEnum.ERROR, errMesg)
      return
    }
    const ideStatus = await fs.readFile(ideStatusFile, 'utf-8')
    if (ideStatus === 'Off') {
      printLog(processTypeEnum.ERROR, errMesg)
      return
    }

    if (!(await fs.pathExists(cliPath))) {
      printLog(processTypeEnum.ERROR, '命令行工具路径不存在', cliPath)
    }
    printLog(processTypeEnum.START, '微信开发者工具...')
    cp.exec(`${cliPath} open --project ${appPath}`, (err) => {
      if (err) {
        printLog(processTypeEnum.ERROR, err.message)
      }
    })
  }

  async preview () {
    const { chalk, printLog, processTypeEnum } = this.ctx.helper
    const { outputPath } = this.ctx.paths
    try {
      printLog(processTypeEnum.START, '上传开发版代码到微信后台并预览')
      const previewQrcodePath = path.join(outputPath, 'preview.jpg')
      const uploadResult = await ci.preview({
        project: this.instance,
        version: this.version,
        desc: this.desc,
        onProgressUpdate: undefined,
        robot: this.pluginOpts.weapp!.robot,
        qrcodeFormat: 'image',
        qrcodeOutputDest: previewQrcodePath
      })
      if (uploadResult.subPackageInfo) {
        const allPackageInfo = uploadResult.subPackageInfo.find((item) => item.name === '__FULL__')
        const mainPackageInfo = uploadResult.subPackageInfo.find((item) => item.name === '__APP__')
        const extInfo = `本次上传${allPackageInfo!.size / 1024}kb ${mainPackageInfo ? ',其中主包' + mainPackageInfo.size + 'kb' : ''}`
        console.log(chalk.green(`开发版上传成功 ${new Date().toLocaleString()} ${extInfo}\n`))
      }
      try {
        const qrContent = await readQrcodeImageContent(previewQrcodePath)
        await printQrcode2Terminal(qrContent)
        printLog(processTypeEnum.REMIND, `预览二维码已生成，存储在:"${previewQrcodePath}",二维码内容是：${qrContent}`)
      } catch (error) {
        printLog(processTypeEnum.ERROR, chalk.red(`获取预览二维码失败：${error.message}`))
      }
    } catch (error) {
      printLog(processTypeEnum.ERROR, chalk.red(`上传失败 ${new Date().toLocaleString()} \n${error.message}`))
    }
  }

  async upload () {
    const { chalk, printLog, processTypeEnum } = this.ctx.helper
    const { outputPath } = this.ctx.paths
    try {
      printLog(processTypeEnum.START, '上传体验版代码到微信后台')
      printLog(processTypeEnum.REMIND, `本次上传版本号为："${this.version}"，上传描述为：“${this.desc}”`)
      const uploadResult = await ci.upload({
        project: this.instance,
        version: this.version,
        desc: this.desc,
        onProgressUpdate: undefined,
        robot: this.pluginOpts.weapp!.robot
      })

      if (uploadResult.subPackageInfo) {
        const allPackageInfo = uploadResult.subPackageInfo.find((item) => item.name === '__FULL__')
        const mainPackageInfo = uploadResult.subPackageInfo.find((item) => item.name === '__APP__')
        const extInfo = `本次上传${allPackageInfo!.size / 1024}kb ${mainPackageInfo ? ',其中主包' + mainPackageInfo.size + 'kb' : ''}`
        console.log(chalk.green(`上传成功 ${new Date().toLocaleString()} ${extInfo}\n`))
      }

      try {
        const uploadQrcodePath = path.join(outputPath, 'upload.png')
        // 体验码规则： https://open.weixin.qq.com/sns/getexpappinfo?appid=xxx&path=入口路径.html#wechat-redirect
        const qrContent = `https://open.weixin.qq.com/sns/getexpappinfo?appid=${this.pluginOpts.weapp!.appid}#wechat-redirect`
        await printQrcode2Terminal(qrContent)
        await generateQrcodeImageFile(uploadQrcodePath, qrContent)
        printLog(processTypeEnum.REMIND, `体验版二维码已生成，存储在:"${uploadQrcodePath}",二维码内容是："${qrContent}"`)
        printLog(processTypeEnum.REMIND, `可能需要您前往微信后台，将当前上传版本设置为“体验版”`)
        printLog(processTypeEnum.REMIND, `若本次上传的robot机器人和上次一致，并且之前已经在微信后台设置其为“体验版”，则本次无需再次设置`)
      } catch (error) {
        printLog(processTypeEnum.ERROR, chalk.red(`体验二维码生成失败：${error.message}`))
      }
    } catch (error) {
      printLog(processTypeEnum.ERROR, chalk.red(`上传失败 ${new Date().toLocaleString()} \n${error.message}`))
    }
  }
}
