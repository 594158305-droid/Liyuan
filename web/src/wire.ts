/** wire 协议类型：单一事实源在 server/wire.ts，此处仅类型再导出（构建期擦除） */
export type {
	AssistantModelInfo,
	AssistantMsg,
	AssistantSessionInfo,
	ClientFrame,
	ExtGenerateParams,
	RpPanel,
	ServerFrame,
	UpdateWire,
	WireActivity,
	WireChannel,
	WireChoice,
	WireMsg,
	WireSessionInfo,
	WireStats,
	WireSwipe,
	WorldState,
} from "../../server/wire.ts";

/**
 * 自定义表格 / 模板类型（DESIGN-custom-tables §1 + DESIGN-template-system §1）：
 * 单一事实源在 src/types.ts 与 src/state.ts，此处仅类型再导出——REST 走 JSON，
 * 结构完全一致，前端无需另立镜像类型。
 * WorldState.tables 已随 server/wire.ts 的 WorldState 再导出（src/types.ts 自带该字段）。
 */
export type {
	CustomTable,
	CustomTableColumn,
	TableColumnType,
	TableTemplate,
	TableTemplateDef,
} from "../../src/types.ts";
export type { TableOp, TableOpResult } from "../../src/state.ts";
