# 来源约定

## 产品交换范围

来源使用 GraphQL federation 风格的实体表示，但 HTTP 路由是本产品已协商的轻量领取协议，不宣称实现完整 GraphQL 执行器。`/primary` 提供 data.products，每个表示包含 __typename、key、fields；key 是 JSON 标量组成的复合对象，字段次序不参与身份。`/schema` 给出每一类型字段归属。`/warehouses` 与 `/parts` 支持 POST，body 为 representations 数组及 fields 数组，返回 data.entities 与 errors；实体按类型和完整 key 关联，不按返回顺序。没有匹配实体与字段显式 null 不同。错误 path 指向 entities 下标和 fields 字段，code=TEMPORARY 可再领，FORBIDDEN 不能伪装空值。GET 用于查看来源示例。阶段 1 使仓储服务原先失败的红色型号可领取。类型 Product 与 Accessory 的相同 key 不是相同对象。补领的字段选择由产品提供可调用入口，现有 /intakes 的单件保存不能改成隐式全量抓取。

## 当前来源路由

- `/primary`：application/json
- `/schema`：application/json
- `/warehouses`：application/json
- `/parts`：application/json

`/catalog` 提供入口及业务选择。资源字节支持 GET/HEAD、单一 bytes 范围、ETag 和 If-Match，响应不会跨来源重定向。`/_phase` 为联调控制路径，不是产品数据来源，不应由产品自行切换阶段。

## 依据和范围说明

- https://www.apollographql.com/docs/federation/subgraph-spec

以上是格式或业务词汇的公开依据；本项目明确限定的交换子集以本文及实际资源为准，未要求完整标准实现。元数据和未支持声明应保留可定位的来源，不把未知转换成已确认的空结果。HTTP 来源状态、原件结构和产品接收完整性是不同层次；现有通用收件接口成功只表示该单件已保存。
