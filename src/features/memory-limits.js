// 记忆系统各层长度与条数上限集中配置（修改此文件即可同步所有 memory 子模块）
export const MEM_LIMITS = {
  // 单条记忆 / 档案 / 印象写入上限
  ITEM_TEXT: 1000,           // 单条事实/经历/修改后的文本上限
  SELF_LINE: 800,            // extractSelf 读取对话与写自身经历的单条上限
  SELF_MAX_ITEMS: 16,        // 单次提炼自身经历条数上限
  EXTRACT_MAX_ITEMS: 32,     // 单次 extractFacts 写入条数上限
  EXTRACT_MAX_TOKENS: 3200,  // extractFacts 模型输出预算
  PROFILE_TEXT: 1200,        // 人物小档案总字数默认上限
  PROFILE_FIELD: 240,        // 人物画像单字段上限
  IMPRESSION_TEXT: 600,      // 群印象单字段/总字数默认上限
  INSIGHT_TEXT: 200,         // 相处经验单条上限
  INSIGHT_MAX_ITEMS: 12,     // 相处经验条数上限
  QUOTE_TEXT: 400,           // sourceRef / 命令原话摘录上限

  // 常驻上下文与认识页（Wiki）上限（适配 1M 上下文大模型，宁可完整也不扣扣嗖嗖截断）
  OWNER_RESIDENT: 40000,     // 主人私聊常驻记忆总上限
  OTHER_RESIDENT: 8000,      // 非主人/群聊/无主人页兜底常驻总上限
  WIKI_OWNER_PAGE: 20000,    // 主人认识页直注全文上限
  WIKI_RECENT_PAGE: 10000,   // 近期与约定热层直注上限
  WIKI_SELF_PAGE: 10000,     // 「我」认识页直注全文上限
  WIKI_CATALOG: 6000,        // 认识页目录摘要上限（含关键词概要）
  WIKI_CATALOG_EXCERPT: 600, // 目录里单页简介上限
  WIKI_REFRESH_FACTS: 60,    // 刷新认识页参考的记忆条数
  WIKI_REFRESH_TOKENS: 6000, // 刷新认识页输出预算
  WIKI_DREAM_TOKENS: 12000,  // 新版结构化 Dreaming 输出预算
  WIKI_EXTRA_CONTEXT: 8000,  // 睡前传给认识页的日程与核实线索上限

  // 近期事实 / 召回 / 跨会话 / 原话检索上限
  FRESH_FACTS_ITEMS: 20,     // 主人认识页后新增事实条数
  FRESH_FACTS_CHARS: 3000,   // 主人认识页后新增事实总字数
  FRESH_FACT_ITEM: 300,      // 单条新增/要紧事实字数
  HOT_FACTS_ITEMS: 16,       // 兜底常驻要紧事条数
  HOT_FACTS_CHARS: 2000,     // 兜底常驻要紧事总字数
  RECALL_OWNER_CHARS: 5000,  // 主人私聊每轮召回总字数
  RECALL_OTHER_CHARS: 2000,  // 其他聊天每轮召回总字数
  RECALL_OWNER_MAX: 16,      // 主人私聊每轮召回最大条数
  RECALL_OTHER_MAX: 10,      // 其他聊天每轮召回最大条数
  CROSS_CHARS: 2400,         // 跨会话感知总字数
  CROSS_LINE: 400,           // 跨会话单条字数
  TAIL_LINE: 400,            // 未提炼尾流水单条字数
  TAIL_MAX_HITS: 6,          // 未提炼尾流水命中条数
  GROUP_BACKDROP_LINE: 500,  // 群聊见闻单条字数
  CHATLOG_LINE: 2000,        // 原话检索与上下文窗口单条字数
  RELATED_TITLE: 80,         // 关联记忆短标题字数

  // 跨日会话交接（Handoff）上限
  HANDOFF_INPUT_LINE: 600,   // 整理交接时单条对话截断
  HANDOFF_SUMMARY: 2400,     // 交接摘要正文上限
  HANDOFF_TOKENS: 2400,      // 交接摘要模型输出预算
  HANDOFF_TAIL_LINE: 500,    // 交接附带最后几句原话单条上限
}
