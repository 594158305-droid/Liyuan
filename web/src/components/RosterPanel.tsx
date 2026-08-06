/**
 * 登场名录面板：追加式索引表（登场过就在案），侧栏面板形态（世界状态卡里放不下）。
 * 活跃条目由记账自动登记不可删；离场条目可删可改注。系统常驻：空表也渲染占位。
 */

import { apiPut, type StatePatchResult } from "../api.ts";
import type { WorldState } from "../wire.ts";
import { IconTrash } from "./icons.tsx";
import { ConfirmButton, useAction } from "./kit.tsx";
import { Editable } from "./StatusStrip.tsx";

/** 三表的展示配置：label + 判断条目当前是否活跃 */
const ROSTER_TABLES = [
	{ key: "characters", label: "人物", activeMark: "在场", goneMark: "已离场" },
	{ key: "items", label: "物品", activeMark: "持有", goneMark: "已失去" },
	{ key: "events", label: "事件", activeMark: "进行中", goneMark: "已了结" },
] as const;

export function RosterPanel({
	state,
	toast,
}: {
	state: WorldState | null;
	toast: (level: "info" | "warning" | "error", text: string) => void;
}) {
	const { run } = useAction(toast);
	const patch = (p: Record<string, unknown>) =>
		run(async () => {
			const r = await apiPut<StatePatchResult>("/api/state", { patch: p });
			for (const w of r.warnings) toast("warning", w);
		});

	const roster = state?.roster;
	const activeSets: Record<(typeof ROSTER_TABLES)[number]["key"], Set<string>> = {
		characters: new Set(Object.keys(state?.characters ?? {})),
		items: new Set(state?.inventory ?? []),
		events: new Set(state?.plot_threads ?? []),
	};
	const tables = ROSTER_TABLES.map((t) => ({
		...t,
		rows: Object.entries(roster?.[t.key] ?? {}),
	}));

	return (
		<div className="panel-body">
			<div className="roster-section roster-panel">
				{tables.map((t) => (
					<div key={t.key} className="roster-table">
						<div className="roster-table-label">{t.label}</div>
						{t.rows.length === 0 ? (
							<div className="roster-empty">（尚无记录，随剧情自动登记）</div>
						) : (
							<div className="roster-rows">
								{t.rows.map(([name, blurb]) => {
									const active = activeSets[t.key].has(name);
									return (
										<div key={name} className={`roster-row ${active ? "" : "roster-gone"}`}>
											<span className="roster-name" title={name}>
												{name}
											</span>
											<span className="roster-blurb">
												<Editable
													value={blurb}
													placeholder="（一句话）"
													onSave={(v) => patch({ roster: { [t.key]: { [name]: v } } })}
												/>
											</span>
											<span className={`roster-mark ${active ? "on" : ""}`}>{active ? t.activeMark : t.goneMark}</span>
											{!active && (
												<ConfirmButton
													title={`从名录移除「${name}」`}
													aria-label="从名录移除"
													confirmText="确认移除"
													onConfirm={() => patch({ roster: { [t.key]: { [name]: null } } })}
												>
													<IconTrash size={12} />
												</ConfirmButton>
											)}
										</div>
									);
								})}
							</div>
						)}
					</div>
				))}
			</div>
		</div>
	);
}
