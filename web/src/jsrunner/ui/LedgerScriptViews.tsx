/**
 * 脚本视图区（D4 §2.7，P2 渲染面）：把 jsrunner 脚本注册的面板渲染进宿主区域。
 *
 * - area="status"：StatusStrip 展开卡 status-card 内、field-hint 之前；
 * - area="roster"：RosterPanel 名录表格下方；
 * - area="left" / "top" / "right"（V2-4）：App 顶栏下横向条 / 左右侧栏底部挂载点。
 *
 * 外部 store 订阅用 useSyncExternalStore（A2）：ledger.getPanels() 返回稳定快照引用
 * （写时重建缓存，不变不重建），无变更不触发重渲染；零注册时渲染 null（零侵入）。
 *
 * 单面板用 React.memo + 全 primitive props 拆分（A3）：某面板 resize 上报只重渲染
 * 自身，不波及其它面板。
 *
 * 挂载副作用（R1-②）：collapsed / modalized / ready 任一为 false 不挂载（收起隐藏、
 * 模态占用、未就绪/崩溃占位）；cleanup 调 scriptRuntimes.unmount 把 iframe 移回
 * #jsrunner-host 隐藏容器——iframe 常驻运行，收起/展开不重载，脚本状态保留。
 *
 * V2-2 拖拽排序：面板头 grip 把手（可聚焦 + Alt+↑/↓ 键盘移动 + 指针拖拽）；释放后
 * ledger.move + 把全局顺序写回 extdata（global:panel-order）；初始化时读回一次。
 * order 持久化放在本组件（ledger.ts 保持零 DOM / 零网络，A5）。
 *
 * V2-5 tab 接管：status 区域存在 position="tab" 面板时渲染 tab 条 [标准] [脚本A]…；
 * 默认「标准」= 现有 status-card 内容；脚本 tab = 该脚本 iframe（高度不钳制）。
 * 无 tab 面板时本组件行为与 V1 完全一致（零侵入）。
 */
import {
	memo,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { getExtData, putExtData } from "../../api.ts";
import { ledger } from "../ledger.ts";
import { scriptRuntimes } from "../runtime.ts";

/** 挂载区域（V2-4：status/roster 之外扩展 left/top/right） */
export type LedgerArea = "status" | "roster" | "left" | "top" | "right";

// ---------- V2-2：面板顺序持久化（extdata global:panel-order；ledger 保持零网络） ----------

/** 持久化键：scope="global"、key="panel-order"（≤128 字符、无点号，满足 extdata 键约束） */
const ORDER_SCOPE = "global";
const ORDER_KEY = "panel-order";
/** 是否已从 extdata 读入过 order（多挂载点组件只读一次） */
let orderHydrated = false;

async function hydrateOrder(): Promise<void> {
	if (orderHydrated) return;
	orderHydrated = true;
	try {
		const value = await getExtData(ORDER_SCOPE, ORDER_KEY);
		if (Array.isArray(value)) ledger.setOrder(value as string[]);
	} catch {
		// 读失败静默：面板保持注册序（无需打扰用户）
	}
}

async function persistOrder(): Promise<void> {
	try {
		await putExtData(ORDER_SCOPE, ORDER_KEY, [...ledger.getOrder()]);
	} catch {
		// 写失败静默：仅本次会话内生效
	}
}

/** LedgerView props：全 primitive（A3：防对象引用导致反复卸载/重挂与全量重渲染） */
interface LedgerViewProps {
	scriptId: string;
	title: string;
	icon?: string;
	collapsed: boolean;
	ready: boolean;
	modalized: boolean;
	height: number;
	maxHeight?: number;
	/** 是否钳制高度（V2-4 left/top/right 自然高、V2-5 tab 面板全卡高时传 false） */
	clampHeight?: boolean;
	/** 是否可拖拽排序（V2-2；tab 面板在 tab 条里排序，body 不显示把手） */
	draggable?: boolean;
}

/** 面板头宿主按钮（P4）：读 ScriptMeta.buttons（visible 过滤）渲染，点击触发脚本动作或广播事件 */
function LedgerViewButtons({ scriptId }: { scriptId: string }) {
	const buttons = (scriptRuntimes.getMeta(scriptId)?.buttons ?? []).filter((b) => b.visible);
	if (buttons.length === 0) return null;
	return (
		<span className="ledger-view-buttons">
			{buttons.map((b) => (
				<button
					key={b.name}
					type="button"
					onClick={(e) => {
						// 不冒泡到面板头：头整行可点，否则点按钮会误触收起/展开
						e.stopPropagation();
						// G3：脚本若用 registerScriptAction 注册了动作（按钮 action 或按钮名），
						// 走带参定向调用；若按钮 action 显式声明不明文存在脚本也不炸（静默忽略）。
						const action =
							typeof b.action === "string" && b.action.trim() ? b.action : b.name;
						// 仍广播 LEDGER_BUTTON_CLICKED 事件兼容既有脚本（eventOn 路径），
						// 动作通道与之不冲突（不同脚本可按自己习惯响应）。
						scriptRuntimes.emitToScript(scriptId, "LEDGER_BUTTON_CLICKED", [b.name]);
						scriptRuntimes.invokeAction(scriptId, action, [b.name]);
					}}
				>
					{b.name}
				</button>
			))}
		</span>
	);
}

/** 单面板：头（grip + icon + 标题 + scriptId 小字 + 收起箭头 + 宿主按钮）+ body（iframe 挂载槽 / 崩溃占位） */
const LedgerView = memo(function LedgerView({
	scriptId,
	title,
	icon,
	collapsed,
	ready,
	modalized,
	height,
	maxHeight,
	clampHeight = true,
	draggable = true,
}: LedgerViewProps) {
	const bodyRef = useRef<HTMLDivElement>(null);
	const [dragging, setDragging] = useState(false);

	// 挂载/卸载副作用：面板出现挂载；收起/模态占用/未就绪不挂载。
	// A3：依赖全为 primitive，避免对象引用导致的反复卸载/重挂
	useEffect(() => {
		const el = bodyRef.current;
		if (!el || collapsed || modalized || !ready) return;
		scriptRuntimes.mount(scriptId, el);
		return () => {
			scriptRuntimes.unmount(scriptId);
		};
	}, [scriptId, collapsed, modalized, ready]);

	const h = clampHeight ? Math.min(height, maxHeight ?? 480) : height;

	/**
	 * V2-2 拖拽释放：把指针位置换算成「本容器内面板」的目标序号（横向 top 区域按 X 轴），
	 * 调 ledger.move（同区域相对位置重排，跨区域相对顺序不变）+ 持久化。
	 */
	const finishDrag = (clientX: number, clientY: number, grip: HTMLElement) => {
		setDragging(false);
		const container = grip.closest(".ledger-views");
		if (!container) return;
		const horizontal = container.classList.contains("ledger-views-top");
		const views = [...container.querySelectorAll(":scope > .ledger-view")];
		let index = views.length - 1;
		for (let i = 0; i < views.length; i++) {
			const rect = views[i].getBoundingClientRect();
			const mid = horizontal ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
			if ((horizontal ? clientX : clientY) < mid) {
				index = i;
				break;
			}
		}
		ledger.move(scriptId, index);
		void persistOrder();
	};

	const onGripPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
		if (e.pointerType === "mouse" && e.button !== 0) return; // 仅鼠标左键
		e.preventDefault(); // 防文本选择/原生拖拽
		e.stopPropagation(); // 不触发行内收起/展开
		e.currentTarget.setPointerCapture(e.pointerId);
		setDragging(true);
	};

	const onGripPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
		if (!dragging) return;
		if (e.currentTarget.hasPointerCapture(e.pointerId)) {
			e.currentTarget.releasePointerCapture(e.pointerId);
		}
		e.stopPropagation();
		finishDrag(e.clientX, e.clientY, e.currentTarget);
	};

	const onGripPointerCancel = (e: React.PointerEvent<HTMLButtonElement>) => {
		setDragging(false);
		if (e.currentTarget.hasPointerCapture(e.pointerId)) {
			e.currentTarget.releasePointerCapture(e.pointerId);
		}
	};

	/**
	 * V2-2 键盘移动：Alt+↑/↓（横向 top 区域 Alt+←/→）；aria-grabbed 语义。
	 * 始终 stopPropagation，避免把 Enter/Space 冒泡给面板头误触收起/展开。
	 */
	const onGripKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
		e.stopPropagation();
		if (!e.altKey) return;
		const container = e.currentTarget.closest(".ledger-views");
		if (!container) return;
		const horizontal = container.classList.contains("ledger-views-top");
		const vertical = !horizontal;
		const valid =
			(vertical && (e.key === "ArrowUp" || e.key === "ArrowDown")) ||
			(horizontal && (e.key === "ArrowLeft" || e.key === "ArrowRight"));
		if (!valid) return;
		const views = [...container.querySelectorAll(":scope > .ledger-view")];
		const index = views.findIndex((el) => el === e.currentTarget.closest(".ledger-view"));
		if (index === -1) return;
		const dir = e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 1;
		const next = index + dir;
		if (next < 0 || next >= views.length) return;
		e.preventDefault();
		ledger.move(scriptId, next);
		void persistOrder();
	};

	return (
		<div className={`ledger-view${dragging ? " dragging" : ""}`} data-dragging={dragging || undefined}>
			<div
				className="ledger-view-head"
				role="button"
				tabIndex={0}
				aria-expanded={!collapsed}
				onClick={() => ledger.toggleCollapsed(scriptId)}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						ledger.toggleCollapsed(scriptId);
					}
				}}
			>
				{draggable && (
					<button
						type="button"
						className="ledger-view-grip"
						title="拖拽排序（Alt+↑/↓ 移动）"
						aria-label={`移动面板：${title}`}
						aria-grabbed={dragging}
						tabIndex={0}
						onPointerDown={onGripPointerDown}
						onPointerUp={onGripPointerUp}
						onPointerCancel={onGripPointerCancel}
						onKeyDown={onGripKeyDown}
						onClick={(e) => {
							// 防冒泡到面板头（头整行可点，否则点把手误触收起/展开）
							e.stopPropagation();
						}}
					>
						⠿
					</button>
				)}
				{icon ? <span className="ledger-view-icon">{icon}</span> : null}
				<span className="ledger-view-title">{title}</span>
				<span className="ledger-view-script">{scriptId}</span>
				<span className="ledger-view-caret">{collapsed ? "▸" : "▾"}</span>
				{/* P4：ScriptMeta.buttons 宿主按钮渲染（点击 emitToScript LEDGER_BUTTON_CLICKED） */}
				<LedgerViewButtons scriptId={scriptId} />
			</div>
			{!collapsed && (
				<div className="ledger-view-body" ref={bodyRef} style={ready ? { height: `${h}px` } : undefined}>
					{!ready && <div className="ledger-view-empty">脚本未就绪/已停止（查看脚本日志）</div>}
				</div>
			)}
		</div>
	);
});

/** V2-5：status 区域 tab 条（[标准] [脚本A] [脚本B]；激活态 aria-selected + .active） */
function LedgerTabs({
	tabPanels,
	active,
}: {
	tabPanels: ReadonlyArray<{ scriptId: string; title: string; icon?: string }>;
	active: string;
}) {
	return (
		<div className="ledger-tabs" role="tablist" aria-label="账本视图">
			<button
				type="button"
				role="tab"
				aria-selected={active === "standard"}
				className={`ledger-tab${active === "standard" ? " active" : ""}`}
				onClick={() => ledger.setActiveTab("standard")}
			>
				标准
			</button>
			{tabPanels.map((p) => (
				<button
					key={p.scriptId}
					type="button"
					role="tab"
					aria-selected={active === p.scriptId}
					className={`ledger-tab${active === p.scriptId ? " active" : ""}`}
					onClick={() => ledger.setActiveTab(p.scriptId)}
				>
					{p.icon ? <span className="ledger-view-icon">{p.icon}</span> : null}
					{p.title}
				</button>
			))}
		</div>
	);
}

/** 脚本视图区：按 area 过滤 ledger 快照；无该区域注册时渲染 null（零侵入） */
export function LedgerScriptViews({ area }: { area: LedgerArea }) {
	// A2：外部 store 用 useSyncExternalStore，getPanels 返回稳定快照引用。
	// 单订阅即可：setActiveTab/move 等都会 rebuildSnapshot → 新快照引用 → 本组件重渲染，
	// 渲染时再读 ledger.getActiveTab() 取最新激活项。
	const panels = useSyncExternalStore(ledger.subscribe, ledger.getPanels);

	// V2-2：首次挂载读一次持久化面板顺序（模块级标记保证多挂载点只读一次）
	useEffect(() => {
		void hydrateOrder();
	}, []);

	const inArea = panels.filter((p) => (p.entry.spec.area ?? "status") === area);
	// V2-5：status 区域 tab 面板（position="tab"）不按普通面板渲染，进 tab 条
	const tabPanels = area === "status" ? inArea.filter((p) => p.entry.spec.position === "tab") : [];
	const appendPanels = area === "status" ? inArea.filter((p) => p.entry.spec.position !== "tab") : inArea;

	// V2-5：status 区域存在 tab 面板 → tab 接管视图（无 tab 面板时走下方 V1 原逻辑，零侵入）
	if (area === "status" && tabPanels.length > 0) {
		const active = ledger.getActiveTab();
		const activePanel = tabPanels.find((p) => p.scriptId === active);
		return (
			<div
				className={`ledger-views ledger-status-tabs${active !== "standard" ? " ledger-tab-script" : ""}`}
				data-active-tab={active}
			>
				<LedgerTabs
					tabPanels={tabPanels.map((p) => ({
						scriptId: p.scriptId,
						title: p.entry.spec.title,
						icon: p.entry.spec.icon,
					}))}
					active={active}
				/>
				{active === "standard" || !activePanel ? (
					appendPanels.map(({ scriptId, entry }) => (
						<LedgerView
							key={scriptId}
							scriptId={scriptId}
							title={entry.spec.title}
							icon={entry.spec.icon}
							collapsed={entry.collapsed}
							ready={entry.ready}
							modalized={entry.modalized}
							height={entry.height}
							maxHeight={entry.spec.maxHeight ?? 480}
							clampHeight
						/>
					))
				) : (
					// 脚本 tab：只渲染该脚本面板；高度不钳制（全卡片高度），不显示拖拽把手
					<LedgerView
						key={activePanel.scriptId}
						scriptId={activePanel.scriptId}
						title={activePanel.entry.spec.title}
						icon={activePanel.entry.spec.icon}
						collapsed={activePanel.entry.collapsed}
						ready={activePanel.entry.ready}
						modalized={activePanel.entry.modalized}
						height={activePanel.entry.height}
						maxHeight={activePanel.entry.spec.maxHeight}
						clampHeight={false}
						draggable={false}
					/>
				)}
			</div>
		);
	}

	if (appendPanels.length === 0) return null;

	// V2-4：status/roster 之外区域给容器加修饰类（top 横向单行 / left、right 自然高）
	const areaClass = area !== "status" && area !== "roster" ? ` ledger-views-${area}` : "";
	const isStandardArea = area === "status" || area === "roster";
	return (
		<div className={`ledger-views${areaClass}`}>
			{appendPanels.map(({ scriptId, entry }) => (
				// A3：primitive props + memo，单面板高度变化不触发其它面板重渲染
				<LedgerView
					key={scriptId}
					scriptId={scriptId}
					title={entry.spec.title}
					icon={entry.spec.icon}
					collapsed={entry.collapsed}
					ready={entry.ready}
					modalized={entry.modalized}
					height={entry.height}
					// V2-4：left/top/right 默认自然高（不钳制）；指定 spec.maxHeight 才钳制
					maxHeight={isStandardArea ? (entry.spec.maxHeight ?? 480) : entry.spec.maxHeight}
					clampHeight={isStandardArea || entry.spec.maxHeight != null}
				/>
			))}
		</div>
	);
}
