# Folder Sync for Zotero

将多个本地 PDF 文件夹映射到 Zotero 个人库分类，先预览目录树与文件归属，再执行同一份计划。

当前版本：`0.2.0-beta.1` 测试版。基础同步保留 PDF 原位，创建或复用 linked attachment，并维护目标分类。手动移动归档按开发计划在后续版本提供。

## 已实现

- 多条独立源目录与目标分类规则；目标分类使用稳定 key 关联。
- 普通目录树、集中分类，以及标准科研知识库布局。
- `raw` 界定知识库根，`raw/papers` 为标准论文目录；保留中间层、空目录与其他原始资料分支。
- 批量预览和单篇导入共享同一套知识库归属逻辑。
- 相同物理路径重复导入复用附件，父文献原有分类继续保留。
- 写入队列处理并发请求，文件或规则变化后提示重新预览。
- 独立 Profile 配置、本地任务记录、取消、CLI 和令牌认证接口。
- 将旧版配置导入为暂停规则，供核对后启用。

## 安装与使用

从 [Releases](https://github.com/SherlocKong/zotero-folder-sync/releases) 下载 XPI。在 Zotero 插件管理器中选择“从文件安装插件”并选择该文件。开发构建产物位于 `dist/`。

工具菜单及 Zotero 设置中提供 Folder Sync 入口：

1. 点击“添加目录”，选择本地文件夹及已经存在的个人库分类。
2. 普通文件夹使用“普通目录树”；科研知识库选择知识库模式，并确定从项目树发现还是根本身就是知识库。
3. 保存规则后生成预览，检查知识库根、分类层级、每个 PDF 的归属、跳过项与错误。
4. 点击“执行当前预览”。新增文件在下一次预览中处理；文件发生变化的动作会报告错误并保留重试机会。
5. 在任务记录中检查新增、复用、补分类及元数据待处理项。

每条启用规则使用独立的源根与目标根分类；相互包含的源目录或目标分类会提示冲突。目标分类可在 Zotero 中先建立，再通过选择器绑定。

标准知识库模式保留以下对应关系：

```text
源：选中项目根 / 项目 / 知识库 / raw / papers / 子目录 / a.pdf
目标：选中分类 / 项目 / 知识库 / raw / papers / 子目录
```

直接选择知识库本身时，知识库名只在绑定目标中出现一次。`raw/standards`、`raw/technical` 及其他有效分支按原位置映射；`raw` 内更深的同名目录属于内容层级。

## 从 phD Project Sync 迁移

在新插件中点击“导入旧配置”，会读取当前 Profile 中原有的项目根和顶层分类，生成一条暂停的标准知识库规则。目录和分类有歧义时需要手动绑定。

核对预览后，停用旧插件，再启用新规则。首次切换前保存旧 XPI 与配置备份。相同文件路径复用已有附件；原文献条目和引用身份继续保留。

## Agent 与 CLI

在“Agent 连接”中启用本地服务，并复制连接文件路径。服务默认关闭；每个 Profile 有自己的令牌与连接文件。

从 [Releases](https://github.com/SherlocKong/zotero-folder-sync/releases) 下载并解压 CLI ZIP，或获取本仓库源码；在解压目录或仓库根目录执行以下命令。CLI 只依赖 Python 3.10+ 标准库。

```bash
python3 cli/folder-sync --connection /path/to/connection.json doctor
python3 cli/folder-sync --connection /path/to/connection.json rules
python3 cli/folder-sync --connection /path/to/connection.json plan --all
python3 cli/folder-sync --connection /path/to/connection.json apply --plan PLAN_ID
python3 cli/folder-sync --connection /path/to/connection.json import /path/to/paper.pdf --rule RULE_ID
python3 cli/folder-sync --connection /path/to/connection.json job JOB_ID
python3 cli/folder-sync --connection /path/to/connection.json cancel JOB_ID
```

也可以通过 `FOLDER_SYNC_CONNECTION` 设置连接文件位置。CLI 只向 loopback 服务发送令牌，绕过 HTTP 代理，并区分成功、部分失败、取消和超时。

配套的 [Build Research Knowledge Base skill](https://github.com/SherlocKong/build-research-knowledge-base) 负责知识库组织与证据追溯；插件负责目录到 Zotero 的映射。将规则配置为标准知识库模式后，可按其 `raw/papers` 约定配合使用。

计划默认保存在当前 Profile 的插件私有状态目录，重启后可以重新核验执行；未完成任务标记为中断。执行时重新检查配置版本与文件状态。

## 文件与元数据

PDF 始终按真实绝对路径交给 Zotero 的附件接口，Zotero 按现有全局附件基目录设置保存相对或绝对引用。

链接附件用于个人库，其文件内容由用户自己的文件存储管理。Zotero 当前不支持在群组库中使用 linked files。[官方文件说明](https://www.zotero.org/support/attaching_files#linked_files)

元数据识别是独立的可选步骤，会调用 Zotero 的识别服务；识别失败后附件仍可访问，任务记录显示待处理。

插件配置和报告存放在当前 Profile 的 `zotero-folder-sync` 目录，源文件夹可以只读。状态文件包含本地路径，令牌文件单独保存。发布包只包含代码与界面文件。

## 开发与验证

要求 Node.js 20+、Python 3.10+；测试和构建使用标准库。

```bash
node --test tests/engine.test.cjs tests/store.test.cjs
python3 -m unittest discover -s tests -p 'test_*.py' -v
python3 scripts/build.py
```

实际应用验证使用独立 Zotero Profile、独立资料目录及合成 PDF，结果与当前兼容范围见 [验证记录](docs/verification.md)。候选版目前在 macOS 上的 Zotero 10 实测；其他平台需完成应用层验收后再扩展实测声明。

构建会检查个人部署路径并按白名单打包，生成 XPI 和 SHA-256 校验文件。更新清单使用本项目的公开仓库地址，公开发布前核验其可访问性。

## 许可证

[MIT License](LICENSE)。
