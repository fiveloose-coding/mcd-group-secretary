# workbuddy.md —— 使用 WorkBuddy 开发本项目的对话上下文

> 本文记录「麦麦拼单秘书」在 **WorkBuddy** 中完成需求分析、方案设计、编码、联调与验证的真实过程，
> 用于核验是否符合 WorkBuddy 联动活动奖励条件。

- 开发工具：WorkBuddy（连接器 + Skill + 本地执行）
- 开发日期：2026-10-11
- 模型：DeepSeek-V4.1-Flash
- 项目：https://github.com/fiveloose-coding/mcd-group-secretary

---

## 对话脉络

### 第 1 轮｜了解赛制

**用户**：根据活动介绍与官方仓库，梳理参赛完整流程（赛题要求、报名方式、时间节点、提交物清单、评审标准）。

**WorkBuddy 做的事**：
- 抓取并通读 `M-China/mcd-developer-innovation-challenge` 仓库的 `README.md`、`activityGuidelines.md`、`CONTEST_DECLARATION.md`、`RANKING.md`；
- 抓取麦当劳 MCP Server 使用指南；
- 核对出关键赛制：报名窗口 2026-10-09 10:30 → 2026-10-25 23:59；排名按**公开 Star 数**；必需文件 5 项；报名 Issue 须发在**活动主仓库**下而非 MCP Server 仓库。

**产出**：一份完整参赛指南（含时间节点、文件清单、避坑红线）。

### 第 2 轮｜配置麦当劳 MCP

**用户**：提供麦当劳 MCP Token，要求完成配置。

**WorkBuddy 做的事**：
- 把 `mcd-mcp` 写入 WorkBuddy 的 MCP 配置 `~/.workbuddy/mcp.json`，保留原有 5 个连接器（agent-mail / redis / ssh / context7 / ufood-data-agent）不受影响；
- 用一次真实 `initialize` 握手验证 Token：返回 `serverInfo = mcd-mcp 1.0.0`、`protocolVersion = 2025-06-18`；
- 拉取 `tools/list`，确认 **35 个工具**全部可用；
- 注意到官方文档示例写 `"type": "streamablehttp"`（全小写），据此把本地配置对齐为官方写法。

### 第 3 轮｜确定选题并验证可行性

**用户**：全权委托开发参赛作品。

**WorkBuddy 做的事**：
- 在 35 个工具中发现一组「**企业团餐**（`beType=6`）」能力：`query-promotions`、`query-meal-assistance`、`query-store-coupons`、`calculate-price`；
- 据此确认选题「麦麦拼单秘书」成立 —— 拼单场景与团餐能力组天然对应。

### 第 4 轮｜真实链路联调（关键）

**WorkBuddy 做的事**（全部为真实 MCP 调用，非文档推测）：

| 步骤 | 工具 | 真实结果 |
|---|---|---|
| 1 | `delivery-query-addresses` | 取到配送地址（福州闽侯） |
| 2 | `delivery-query-stores` | 取到团餐门店：麦当劳福州高新区新保路餐厅 `storeCode=1410264` / `beCode=141026481` |
| 3 | `query-meals` | 取到 **57 个真实团餐 SKU**，分 5 个分类 |
| 4 | `query-meal-assistance` | 取到 **3 档助餐服务**：保鲜速达 GMS001 / 专人分餐 GMS002 / 专人摆台 GMS003 |
| 5 | `query-promotions` | 取到团餐促销规则（满额折扣） |
| 6 | `calculate-price` | 取到权威计价结果 |

**联调中发现并修正的真实问题**：

1. **团餐场景 `calculate-price` 必须传 `gmServiceCode`**，否则返回 `600061 团餐助餐服务参数缺失`（该约束未在工具描述中显式给出，是实测发现的）；
2. **返回结构有两层**：外层是业务信封 `{success, code, message, data}`，价格在内层 `data`。首次实现少剥一层导致「所有方案计价失败」，已修正；
3. **Git Bash 的 MSYS 路径转换**会把 `/user` 这类参数改写成 Windows 路径，导致 GitHub API 调用失败；改为「调用时省略前导斜杠、由脚本补齐」规避；
4. **助餐服务档位会显著影响实付**：同一张 ¥477.50 的商品单，GMS001 实付 ¥381.45，GMS003 实付 ¥453.08，**相差 ¥71.63**。

### 第 5 轮｜编码与测试

**WorkBuddy 做的事**：
- 写出 7 个源码文件 + 5 个测试文件，全部零第三方依赖；
- 跑 `node --test`：**首轮 55 个用例中 2 个失败**，测试暴露出 2 个真实缺陷：
  - 缺陷 A：`共享: 薯条 x2 @A @B` 的数量解析失败（数量正则锚定行尾，被 `@提及` 挡住）；
  - 缺陷 B：`张三:`（只有冒号无内容）的报错信息不精确；
- 修复后复测：**55/55 全部通过**；
- 端到端跑通 `plan` 命令：5 人拼单、7 条菜品全部匹配、三档助餐服务计价成功、逐人账单与 MCP 权威计价**交叉核对完全一致**。

---

## 本项目中 WorkBuddy 承担的角色

| 环节 | 承担方 |
|---|---|
| 赛制信息抓取与规则核对 | WorkBuddy |
| MCP 连接器配置与连通性验证 | WorkBuddy |
| 选题可行性论证（基于真实工具清单） | WorkBuddy |
| 代码编写 / 单测 / 联调 / 缺陷修复 | WorkBuddy |
| GitHub 仓库创建、代码推送、报名 Issue 提交 | WorkBuddy |
| 提供麦当劳 MCP Token、确认最终交付 | 用户 |

---

## 可复核的验证入口

```bash
# 1. 纯函数层（不联网、不需要 Token）
node --test tests/*.test.mjs

# 2. MCP 连通性自检
MCD_MCP_TOKEN=<Token> node src/group-secretary.mjs doctor

# 3. 端到端生成拼单方案
MCD_MCP_TOKEN=<Token> node src/group-secretary.mjs plan \
  --store 1410264 --be-code 141026481 \
  --file examples/sample-order.txt --date "2026-10-12 12:00"
```
