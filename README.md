# federated-stock

联合目录中分属不同服务的实体字段补采相关资料接收服务，面向授权来源的原件领取、解释和持久查询。

## 当前能力

现有服务逐项保存商品服务返回的实体表示，能查询原始字段及来源。新增的按字段领取能把一批商品补采成完整记录：按来源的字段归属约定向仓储、配件等服务领取缺失字段，区分已确认（含显式空值）、临时失败、无权查看与未匹配实体；每个值都登记来源请求，仍未收到的字段可持久查询，补领只针对未确认字段。

`src/reader.mjs` 提供现有单件读取契约；`src/transport.mjs` 只访问配置来源的同源地址，拒绝隐式跳转；`src/store.mjs` 保存原件摘要、解释结果与领取批次。`src/collector.mjs` 是按字段领取的领域逻辑，`src/service.mjs` 是产品入口，`src/provider.mjs` 是独立 HTTP 联调来源，内容为无个人信息的本地样例。

## 环境与运行

Node.js 22.22 至 22.x，无 npm 依赖，无外部运行服务或下载步骤。Linux、Windows 均使用以下命令；干净目录可直接运行。

```sh
npm ci --offline --ignore-scripts
npm test
npm run build
npm run demo
```

`npm run demo` 自动在本机回环端口启动来源与产品、领取一件资料、按字段领取一批记录并在来源恢复后补领收齐，然后关闭服务并清理临时目录。它展示当前产品能力，不模拟尚不存在的能力。演示没有固定等待、外网访问或人工操作，通常数秒结束。扩展产品后可按实际能力更新演示路径；不要以打印预先保存的结果替代运行。

分开运行时，先 `npm run source`，来源监听 127.0.0.1:4101；在另一终端设置 SOURCE_URL=http://127.0.0.1:4101 后运行 `npm start`，产品默认 4102。DATA_DIR 可设置资料目录，PORT 可分别覆盖监听端口。构建产物位于 dist，当前脚本仅使用 Node 内置模块。

## 已有接口

- GET /health：服务状态。
- POST /intakes，JSON 为 {"path":"/primary"}：按现有 reader 接收单件原件；内容解释失败不登记资料。
- GET /records：持久接收目录；同 source URL、同摘要重领返回原 id。
- GET /objects/{digest}：读取已保存的原始字节。
- POST /collections，JSON 如 {"fields":["name","stock"]}：新建一批按字段领取的记录；path 可覆盖来源入口，fields 缺省为归属约定的全部字段。同批允许部分商品已收齐、部分仍缺字段。
- POST /collections/{id}/claims：补领该批仍未确认的字段；已确认与无权查看的字段不再领取。
- GET /collections：各批次完成度与缺项数目摘要。
- GET /collections/{id}：整批记录，含每个字段的状态、值与来源请求。
- GET /collections/{id}/outstanding：该批仍未收到的字段、状态与最近错误。

既有接口保持兼容，后续扩展可以新增业务入口，但不能把 GET 请求变为写操作。收件记录当前只包含单件 raw 对象，不代表关联资料已完整；批次记录才表达字段级完整度。

## 字段状态与溯源

字段状态：confirmed 已确认（value 可为显式 null，表示来源确认为空，与未收到不同）；temporary 临时失败（TEMPORARY、未知错误码或请求失败），可补领；forbidden 无权查看（FORBIDDEN），不伪装成空值，也不再补领；missing 来源无匹配实体或未返回该字段；pending 尚未领取。无法归属到具体实体的字段错误不会确认该次响应里的任何同名字段。

每个 confirmed 值的 origin.request 对应批次 requests 日志中的一次实际请求；日志条目含服务、路径、方法、领取字段、目标实体与响应摘要 digest，digest 可经 GET /objects/{digest} 核对当次响应原件。商品服务自有的字段只随入口列表到达，不作为实体服务补领目标。

## 来源与资料

交换范围、字段和边界见 [来源约定](docs/upstream.md)，样例资源清单可访问来源的 /catalog。`fixtures/upstream.json` 描述 HTTP 资源和阶段变体，不包含产品实现。GET /_requests 可查实际领取请求；POST /_phase 接收 {"phase":1} 切换已定义的来源状态，切回 0 恢复。所有资料都限于公开约定或本地合成数据，不向真实业务系统写入。

## 测试与构建

`npm test` 覆盖现有读取器、畸形输入、真实 HTTP 领取、原件一致性、持久重开、同源边界和范围响应；领域读取行为在 test/domain.test.mjs，按字段领取的领域行为在 test/collector.test.mjs，端到端领取、补领与批次持久化在 test/collection.test.mjs。`npm run build` 对运行模块逐个执行语法校验并复制到 dist。`docker build -t federated-stock:local .` 可创建产品运行镜像；镜像默认运行实际演示，不含远程业务凭据。
