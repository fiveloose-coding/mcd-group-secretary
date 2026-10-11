# MCP 集成说明

> 本文说明「麦麦拼单秘书」实际使用的**麦当劳中国 MCP Server**、**Tool 清单**、**端到端调用流程**与**业务价值**。所有工具名与参数均取自 `tools/list` 的真实返回，而非文档转述。

---

## 1. 使用的 MCP Server

| 项 | 值 |
|---|---|
| 名称 | 麦当劳中国 MCP Server |
| 端点 | `https://mcp.mcd.cn` |
| 传输协议 | Streamable HTTP（JSON-RPC 2.0） |
| 协议版本 | `2025-06-18` |
| 服务端版本 | `mcd-mcp 1.0.0`（实测 `initialize` 返回） |
| 鉴权方式 | 请求头 `Authorization: Bearer <MCP Token>` |
| 会话机制 | `initialize` 响应返回 `Mcp-Session-Id`，后续请求回带该头 |
| 工具总数 | **35**（实测 `tools/list` 返回） |
| 服务端限流 | 文档标注 600 次/分钟；超限返回 `429`，Token 无效返回 `401` |

客户端实现见 [`src/mcd-client.mjs`](./src/mcd-client.mjs)，零第三方依赖（使用 Node.js 内置 `fetch`），完整实现 `initialize` → `notifications/initialized` → `tools/list` → `tools/call` 四步握手。

---

## 2. 实际调用的 Tool 清单

### 2.1 主流程调用（`plan` 命令，只读）

| # | Tool 名称 | 作用 | 关键参数 | 在流程中的位置 |
|---|---|---|---|---|
| 1 | `query-meals` | 拉取门店餐品列表 | `storeCode` `orderType` `beType` | 步骤 1：拿到真实菜单 SKU 池 |
| 2 | `query-meal-detail` | 查单个餐品的组成/可替换项 | `storeCode` `orderType` `beType` `code` | 步骤 2：当拼单文本指向套餐、需展开组成时按需调用 |
| 3 | `query-promotions` | 拉取门店当前有效的促销规则（满减/满折） | `storeCode` `orderType` `beType` | 步骤 3：获取优惠规则，**仅企业团餐场景（`beType=6`）返回数据** |
| 4 | `query-store-coupons` | 拉取「指定门店 + 订单类型」下可用券 | `storeCode` `orderType` `beType` | 步骤 3：与促销规则合并为优惠候选集 |
| 5 | `query-meal-assistance` | 拉取门店可用助餐服务 | `storeCode` | 步骤 3：**仅企业团餐场景**，须在 `calculate-price` 之前调用 |
| 6 | `calculate-price` | **权威计价**（返回含优惠后的价格） | `storeCode` `orderType` `beType` | 步骤 4：对每个候选方案计价，结果作为**唯一价格来源** |

### 2.2 前置与辅助调用

| Tool 名称 | 作用 | 关键参数 | 使用场景 |
|---|---|---|---|
| `query-nearby-stores` | 查可点餐门店（到店自提 / 车道取餐） | `beType` `searchType` | `stores` 命令：还没定门店时先找店 |
| `delivery-query-stores` | 按配送地址查可外送门店 | `beType` `addressId` | 外送场景找店 |
| `delivery-query-addresses` | 查用户配送地址列表 | — | 外送场景读取地址 |
| `auto-bind-coupons` | 一键领取当前可领优惠券 | — | **用户显式授权后**才调用，用于把可领券纳入候选集 |
| `query-my-coupons` | 查用户卡包中已有券 | — | 纳入候选集（不做门店可用性承诺） |
| `available-coupons` | 查可领取的「麦麦省」券列表 | — | 候选集补充 |
| `now-time-info` | 取服务端当前时间 | — | 判断促销/活动是否在有效期内 |
| `campaign-calendar` | 查当月营销活动日历 | — | 补充活动维度的省钱线索 |
| `list-nutrition-foods` | 查餐品营养成分 | — | 可选：为团队里关注热量的人标注营养信息 |
| `query-order` / `order-list` | 查订单详情 / 历史订单 | `orderId` | 可选：核对上次拼单的实际情况 |

### 2.3 本流程中**刻意不调用**的 Tool

| Tool 名称 | 不调用的原因 |
|---|---|
| `create-order` | **会产生真实消费**。本项目默认只出方案，不下单；下单需人工确认后单独触发 |
| `party-order-create` | 同上（派对/体验营类预订涉及支付与排期） |
| `mall-create-order` | 同上（积分兑换涉及扣减积分） |
| `cancel-order` | 破坏性操作，不在自动流程内 |
| `draw-lottery` | 消耗积分，与拼单无关 |
| `delivery-create-address` | 写用户地址簿，非本流程必需 |

---

## 3. 端到端调用流程

```
用户输入：门店 + 场景 + 拼单文本
        │
        ▼
[1] query-meals ──────────────────► 真实菜单 SKU 池
        │
        ▼
[2] menu-match.matchItem()  ◄── 纯函数，本地执行（不联网）
        │   精确 → 别名 → 包含 → 二元组相似度
        │   低于阈值 → 标记「待确认」并返回候选列表
        ▼
[3] query-promotions ─────────────► 促销规则（团餐满减/满折）
    query-store-coupons ──────────► 门店可用券
    query-meal-assistance ────────► 助餐服务（仅 beType=6）
        │
        ▼
[4] calculate-price  × N 个候选方案 ─► 每个方案的权威总价
        │
        ▼
[5] savings.compareScenarios() ◄── 纯函数，本地执行
        │   取最低价方案，输出与基准价的差额
        ▼
[6] bill-split.splitBill() ◄── 纯函数，本地执行
        │   整数分运算 + 不变量校验（Σ 个人应付 === 实付）
        ▼
[7] 输出方案（Markdown 摘要 + JSON）
        │
        ▼
    人工确认 → （如需下单）由用户显式触发下单类 Tool
```

关键分工：**联网部分只做数据获取与权威计价，涉钱的算法全部在本地纯函数中完成**，且每次分摊都做不变量校验。

---

## 4. 业务价值

1. **把「隐性知识」变成「可执行流程」**：团队拼单最耗时的不是点单，而是「对菜单、凑优惠、算钱」三件事的反复沟通。本项目把这三件事固化成一个命令。
2. **用 MCP 解决「数据可信」问题**：菜单、门店、促销、最终价格全部来自麦当劳官方接口，不存在过期价目表或拍脑袋估算。
3. **用企业团餐能力解决「人多的单」**：MCP 的 `beType=6` 企业团餐场景提供了 `query-promotions` + `query-meal-assistance` + `calculate-price` 一整套能力，正好对应「给一群人订餐」的真实需求，而多数拼单工具并未利用这一能力组。
4. **把消费风险挡在流程之外**：所有会产生真实支出的 Tool 都被排除在自动流程之外，方案与执行之间强制插入人工确认。

---

## 5. 价格权威性设计（重要取舍）

麦当劳的定价与优惠叠加规则属于业务方权威。任何在客户端重写一遍的计算，都会随规则调整而失准。

因此本项目确立一条硬规则：

> **本地代码永远不计算价格，只负责准备场景、调用 `calculate-price`、比较返回结果。**

这条规则带来的直接好处是：当麦当劳调整促销规则时，本项目**无需改动任何代码**即可得到正确结果。

---

## 6. 实测记录

### 6.1 连通性与工具

| 项目 | 结果 |
|---|---|
| `initialize` | 成功，返回 `serverInfo: mcd-mcp 1.0.0` / `protocolVersion: 2025-06-18` |
| `tools/list` | 成功，返回 **35** 个工具 |
| 实时业务数据 | 成功拉取当日促销活动数据，证明 Token 与链路真实可用 |
| `tools/call` | 成功，`initialize` → `notifications/initialized` → `tools/call` 链路正常 |

### 6.2 真实业务链路（2026-10-11 实测）

| 调用 | 真实返回 |
|---|---|
| `delivery-query-addresses` | 返回 1 个配送地址（福州闽侯） |
| `delivery-query-stores`（`beType=6`） | 返回可用团餐门店，取 **麦当劳福州高新区新保路餐厅**：`storeCode=1410264`、`beCode=141026481` |
| `query-meals`（`beType=6`、`orderType=2`） | 返回 **57 个团餐 SKU**，分 5 个分类（人气热卖 / 主食 / 小食甜品 / 饮品 / 开心乐园） |
| `query-meal-assistance` | 返回 **3 档助餐服务**：`GMS001 保鲜速达`（可启用）、`GMS002 专人分餐`、`GMS003 专人摆台`（后两者需提前 4h 预约） |
| `query-promotions` | 返回多条团餐促销规则（含 `orderDiscount` 满额折扣配置） |
| `query-store-coupons`（团餐） | 返回空数组 —— 该门店团餐场景无店级券 |
| `calculate-price` | 返回完整计价明细，字段见 6.3 |

### 6.3 计价返回结构与权威公式

`calculate-price` 的返回体（`data` 部分）包含：

```
productOriginalPrice    商品原价合计（分）
productPrice            商品实付合计（分）
deliveryOriginalPrice   配送费（分）
deliveryPrice           配送费实付（分）
packingOriginalPrice    打包费（分）
packingPrice            打包费实付（分）
originalPrice           订单原价合计（分）
discount                优惠金额（分）
price                   ★ 订单实付合计（分）—— 本项目的唯一价格来源
productList[]           逐商品明细（含 originalSubtotal / subtotal）
mealAssistanceList[]    本单采用的助餐服务
enjoyable               优惠相关信息（见下方说明）
```

**实测验证通过的权威公式**：

```
price = productOriginalPrice + deliveryOriginalPrice + packingOriginalPrice − discount
```

两条实测样例（同门店、同商品）：

| 商品原价 | 配送费 | 打包费 | 优惠 | 实付 | 验算 |
|---|---|---|---|---|---|
| ¥477.50 | ¥6.00 | ¥15.00 | ¥117.05 | ¥381.45 | 47750 + 600 + 1500 − 11705 = 38145 ✅ |
| ¥477.50 | ¥6.00 | ¥15.00 | ¥45.42 | ¥453.08 | 47750 + 600 + 1500 − 4542 = 45308 ✅ |

### 6.4 文档并未写明、只能靠实测发现的约束

1. **团餐场景 `calculate-price` 必须传 `gmServiceCode`**
   不传会直接失败：`code=600061`，`message="团餐助餐服务参数缺失"`。该约束在工具描述中并未显式声明。
2. **团餐的订单类型固定为 `orderType=2`（外送）**
   工具描述里写明「团餐场景固定传 2（外送）」，传 `1` 不成立。
3. **助餐服务档位会显著改变实付金额**
   同一张商品原价 ¥477.50 的单：`GMS001 保鲜速达` 实付 ¥381.45，`GMS003 专人摆台` 实付 ¥453.08，**相差 ¥71.63**。
   这直接证明「必须逐档实测比价」的设计是对的 —— 差额无法从规则文本估算出来。
4. **`enjoyable` 字段语义未定义**
   返回形如 `{"amountType":"2","realDiscount":7.4,"balance":2250}`，其中 `realDiscount` 在不同助餐服务档位下取值不同（7.4 / 8.8 / 9.3）。
   `tools/list` 与响应说明中均未定义其含义，因此**本项目只原样展示该字段，绝不参与任何金额计算**。

> 复现方式：`MCD_MCP_TOKEN=<你的 Token> node src/group-secretary.mjs doctor`
> 端到端复现：`MCD_MCP_TOKEN=<你的 Token> node src/group-secretary.mjs plan --store 1410264 --be-code 141026481 --file examples/sample-order.txt --date "2026-10-12 12:00"`
