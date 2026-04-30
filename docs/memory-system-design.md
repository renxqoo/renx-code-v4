# Memory System Design

## 核心原则

1. **记忆分类治理** — Soul / User / Memory / Agent 四层，各司其职
2. **渐进式三层披露** — 固定层全量注入 / 检索层按需填充 / 技能层轻量注入
3. **自我进化** — Soul 人工演化、User LLM 自动合并、Memory 向量+图谱自动抽取、Skill 从经验中自动生长

---

## 一、四层记忆架构

```
┌─────────────────────────────────────────────────────────────┐
│  Agent Run Context (Token Budget)                           │
│                                                             │
│  Layer 1: SOUL    │  角色提示词 (MD, 固定开销)                 │  ← 永远在场
│  Layer 2: USER    │  用户概要 (MD, ~200 token, 固定开销)       │  ← 全量注入
│  Layer 3: MEMORY  │  向量+图谱 (JSON存储/MD注入, 按需检索)     │  ← 动态填充
│  Layer 4: AGENT   │  自生成Skill (MD, 按需检索)               │  ← 动态填充
│                                                             │
│  剩余空间: 当前对话的上下文消息                                  │
└─────────────────────────────────────────────────────────────┘
```

### Token 分配逻辑

- Soul + User = 固定成本，每次运行必定注入
- 剩余 budget 分配给 Memory 检索结果和 Skill 匹配结果
- 按 relevance 排序，超出 budget 截断

---

## 二、MD vs JSON 分界线

| Layer   | 存储格式 | 注入格式 | 更新方式   | 理由                         |
|---------|---------|---------|-----------|------------------------------|
| Soul    | MD      | MD      | 人工+演化  | 全量固定, 给LLM的就是自然语言    |
| User    | MD      | MD      | LLM merge | 200 token 全量注入, 无需程序拆字段 |
| Memory  | JSON    | MD      | 程序化    | 需要向量内积、图谱遍历、重排序    |
| Agent   | MD      | MD      | LLM 生成  | 本质就是 prompt 片段            |

**原则**: 需要程序读写/检索/索引的用 JSON。只给 LLM 消费的用 MD。存储 JSON 的层在注入时渲染为 MD。

---

## 三、全量消息 vs 上下文消息

两套消息链路严格分离：

```
┌─────────────────────────────────────────┐
│  全量消息存储 (Source of Truth)           │
│  append-only, 永不截断, 永不修改            │
│  用途: Memory ETL, Skill 发现, 审计        │
│  存储: JSONL 文件 (withConversationHistory)│
└──────────────────┬──────────────────────┘
                   │ 消费
          ┌────────▼─────────┐
          │   Memory ETL     │
          │  (消费全量消息)    │
          └──────────────────┘

┌──────────────────────────────────────────┐
│  上下文消息 (喂给 LLM)                      │
│  滑动窗口, 超出部分压缩为摘要                 │
│  用途: 当前 LLM 调用的 context              │
│  存储: state.messages (内存)               │
└──────────────────────────────────────────┘
```

### 压缩规则

- 上下文消息超过 token 阈值时触发压缩
- 最早的 N 条消息 → LLM 生成摘要 → 替换为一个 summary block
- 压缩只影响 LLM 输入，Memory ETL 始终消费全量消息

---

## 四、Memory ETL Pipeline

每次对话结束后，一次 LLM 调用完成所有层的提取：

```
                    ┌─── 全量对话 ───┐
                    │  messages[]    │
                    │  + context     │
                    └───────┬────────┘
                            │
                    ┌───────▼────────┐
                    │  Memory ETL    │  一次调用，结构化输出
                    │  (LLM)         │
                    └───────┬────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
   ┌────▼────┐      ┌──────▼──────┐      ┌─────▼─────┐
   │ Soul    │      │   Memory    │      │ Agent     │
   │ 演化建议 │      │  结构化抽取  │      │ Skill 生成 │
   │ (罕见)  │      │ facts/events│      │ (模式匹配) │
   └────┬────┘      └──────┬──────┘      └─────┬─────┘
        │                  │                   │
   ┌────▼────┐      ┌──────▼──────┐      ┌─────▼─────┐
   │人工审批  │      │ embedding   │      │ pending   │
   │→ merge  │      │ → pgvector  │      │ → 验证后   │
   │         │      │ → 图谱存储   │      │ active    │
   └─────────┘      └─────────────┘      └───────────┘

                    ┌──────▼──────┐
                    │   User      │
                    │ LLM merge   │
                    │ 旧MD+新信息  │
                    │ → 新MD      │
                    └─────────────┘
```

### ETL 输入

- 全量对话 messages[]（原始消息，非压缩后的）
- 当前 User Profile (MD)
- 当前 Soul (MD)

### ETL 输出 (JSON Schema)

```json
{
  "userProfileUpdate": "<merged MD content>" | null,
  "memories": [
    {
      "content": "concise single-sentence memory",
      "summary": "ultra-short summary for embedding (<=50 chars)",
      "type": "fact" | "decision" | "event" | "lesson",
      "entities": ["entity-name-1", "entity-name-2"]
    }
  ],
  "skillCandidate": "<MD prompt fragment>" | null,
  "soulSuggestion": "<suggested role evolution>" | null
}
```

### 记忆类型定义

- **fact**: 客观事实 — 项目、代码库、工具、用户信息
- **decision**: 本次对话中做出的选择或决定
- **event**: 值得记录的里程碑事件
- **lesson**: 从成功或失败中获得的经验洞察

### ETL 输出后处理

```
userProfileUpdate  → 直接覆盖 User Profile 存储
memories[]         → summary → embedding → pgvector INSERT
                  → entities[] → 图谱节点/边更新
skillCandidate     → 写入 Skill Store, status = "pending", 做 embedding
soulSuggestion     → 写入待审批队列, 不自动生效
```

---

## 五、存储层设计

### 方案：PostgreSQL + pgvector

- 与项目现有 PostgresAdapter 技术栈统一
- 一个实例覆盖向量检索 + 图谱查询 + 配置存储
- 额外依赖: pgvector 扩展 + embedding 模型 (通过 @renx/provider)

### 表结构

```sql
-- ============================================================
-- 一表三层: Soul MD / User MD / Skill MD
-- ============================================================
CREATE TABLE profiles (
  key         TEXT PRIMARY KEY,              -- "soul", "user:{userId}", "skill:{skillId}"
  content     TEXT NOT NULL,                 -- MD 内容
  version     INT DEFAULT 1,
  status      TEXT DEFAULT 'active',         -- skill 用: "pending" | "active" | "archived"
  embedding   VECTOR(1536),                 -- skill 用: 检索匹配
  metadata    JSONB DEFAULT '{}',           -- skill: { successRate, useCount, parentRun }
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON profiles USING ivfflat (embedding vector_cosine_ops)
  WHERE key LIKE 'skill:%';

-- ============================================================
-- 向量记忆表
-- ============================================================
CREATE TABLE memories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content       TEXT NOT NULL,               -- 原始记忆文本
  summary       TEXT NOT NULL,               -- 供 embedding (<=50 chars)
  embedding     VECTOR(1536),               -- OpenAI text-embedding-3-small
  type          TEXT CHECK (type IN ('fact','decision','event','lesson')),
  importance    REAL DEFAULT 0.5,           -- 0-1
  access_count  INT DEFAULT 0,              -- 检索命中次数
  created_at    TIMESTAMPTZ DEFAULT now(),
  last_accessed TIMESTAMPTZ,
  session_id    TEXT,                       -- 来源会话
  run_id        TEXT                        -- 来源 run
);

CREATE INDEX ON memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ============================================================
-- 图谱: 实体节点
-- ============================================================
CREATE TABLE entities (
  id            TEXT PRIMARY KEY,            -- 语义 ID, e.g. "renx-code-v4"
  name          TEXT NOT NULL,
  type          TEXT CHECK (type IN ('project','tool','concept','person','skill')),
  properties    JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- 图谱: 关系边
-- ============================================================
CREATE TABLE relations (
  from_entity   TEXT REFERENCES entities(id),
  to_entity     TEXT REFERENCES entities(id),
  type          TEXT,                        -- "depends_on", "uses", "creates"
  weight        REAL DEFAULT 1.0,
  PRIMARY KEY (from_entity, to_entity, type)
);

-- ============================================================
-- 记忆-实体关联
-- ============================================================
CREATE TABLE memory_entities (
  memory_id     UUID REFERENCES memories(id),
  entity_id     TEXT REFERENCES entities(id),
  PRIMARY KEY (memory_id, entity_id)
);
```

### 混合检索流程

```sql
-- Step 1: 向量检索
SELECT id, content, summary, type,
       1 - (embedding <=> $query_embedding) AS similarity
FROM memories
ORDER BY embedding <=> $query_embedding
LIMIT $top_k;

-- Step 2: 图谱扩展 (1 跳邻居)
SELECT DISTINCT m.id, m.content, m.summary, m.type
FROM memory_entities me
JOIN relations r ON me.entity_id = r.to_entity
JOIN memory_entities me2 ON r.from_entity = me2.entity_id
JOIN memories m ON me2.memory_id = m.id
WHERE me.memory_id = ANY($matched_memory_ids);

-- Step 3: 应用层重排序
-- score = similarity × 0.5 + importance × 0.3 + recency × 0.2
-- 在 token budget 内取 topN
```

### 总体存储视图

```
PostgreSQL
├── runs                  ← 现有 PostgresAdapter
├── run_events            ← 现有 PostgresAdapter
├── profiles              ← NEW: Soul / User / Skill MD
├── memories              ← NEW: 向量记忆
├── entities              ← NEW: 图谱节点
├── relations             ← NEW: 图谱边
└── memory_entities       ← NEW: 记忆-实体关联
```

---

## 六、渐进式三层披露在 Token Budget 中的体现

```
┌────────────────────────────────────────────────┐
│ 第一层 (固定注入, 每次都有)                       │
│   - Soul: 角色提示词 (MD)                        │
│   - User: 用户概要 (MD, ~200 token)              │
│   - 当前上下文消息                                │
├────────────────────────────────────────────────┤
│ 第二层 (按需检索, 有就用, 没有就跳过)              │
│   - Memory: 向量检索 topK + 图谱 1 跳扩展         │
│   - 超出 token budget 时按 relevance 截断          │
├────────────────────────────────────────────────┤
│ 第三层 (轻量, 元信息)                             │
│   - Skill: 匹配到的自生成 prompt 片段              │
│   - Skill 是高度压缩的经验, token 开销很小         │
└────────────────────────────────────────────────┘
```

---

## 七、记忆治理

### 遗忘机制

- `importance` × `decayFactor(recency)` × `accessCount` < 阈值 → 归档或删除
- 定期任务扫描，不是每次检索都做

### 合并机制

- 同一实体的多个相似记忆 → LLM 合并为一条总结性记忆
- 触发条件: 实体关联记忆数 > N 且相似度 > 阈值

### 冲突检测

- 新记忆 vs 旧记忆矛盾 → 标记 conflicting
- 优先使用新记忆，旧记忆降权

### Skill 生命周期

```
pending  ← 新生成
    │ 被成功使用 3 次
    ▼
active
    │ 连续失败或长期未使用
    ▼
archived
```

### Soul 演化

- ETL 可能产生 soulSuggestion
- 不自动生效，写入待审批队列
- 人工决定是否 merge

---

## 八、与现有系统的关系

### withConversationHistory (已有, 保留)

- 做 append-only 原始日志 (JSONL)
- 提供全量消息给 Memory ETL 消费
- 不参与上下文压缩

### withContextCompression (需新增)

- 管理滑动窗口和摘要
- state.messages 超 token 阈值时触发
- 压缩只影响 LLM 输入

### withMemory (需新增, 核心插件)

- 封装 Soul / User / Memory / Skill 四层
- 一次 ETL 调用完成所有层提取
- 检索时: 向量 + 图谱混合检索 → 注入上下文
- 对话后: ETL 提取 → 更新各层存储

---

## 九、插件组合示意

```typescript
pipe(
  withConversationHistory({ maxMessages: 50 }),   // 原始日志
  withContextCompression({ maxTokens: 8000 }),     // 上下文压缩
  withMemory({                                      // 四层记忆
    provider: "pgvector",
    embeddingModel: "text-embedding-3-small",
    retrieval: { topK: 5, minRelevance: 0.7 },
  }),
  withApproval(),                                   // 人工审批
  agent                                             // 核心
)
```

---

## 十、实现顺序建议

1. **存储层**: PG 表结构和 pgvector 索引
2. **ETL Prompt**: 一次 LLM 调用的 prompt 模板和结构化输出解析
3. **检索逻辑**: 向量检索 + 图谱扩展 + 重排序
4. **上下文组装**: 四层 MD 注入到 system prompt
5. **记忆治理**: 遗忘/合并/冲突检测的后台任务
6. **Skill 生命周期**: pending → active → archived 状态机
7. **withMemory 插件**: 最终封装
