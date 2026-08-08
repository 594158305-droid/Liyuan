/**
 * 在场角色检出（插件 A draw-role，DESIGN-draw §3.1 一期）：正文里按名字匹配。
 *
 * 零依赖纯 TS。匹配策略：knownNames 按长度降序（长名优先，防短名误伤如
 * 「reimu」先命中「hakurei_reimu」的子串）；大小写不敏感；返回按正文出现顺序去重。
 */

/**
 * 在正文中检出在场角色：
 * - knownNames 按长度降序匹配（长名优先，防短名误匹配）
 * - 返回按正文出现顺序去重后的名字；大小写不敏感
 * - knownNames 空 → 返回 []
 */
export function detectPresentCharacters(text: string, knownNames: string[]): string[] {
	const body = (text ?? "").toLowerCase();
	if (!body) return [];
	if (!Array.isArray(knownNames) || knownNames.length === 0) return [];

	const names = [...new Set(knownNames.filter((n) => typeof n === "string" && n.trim()))];
	// 长名优先（防御性排序：先长后短，长名覆盖短名子串）
	names.sort((a, b) => b.length - a.length);

	const hits: { name: string; pos: number }[] = [];
	const matched = new Set<string>();
	for (const raw of names) {
		const name = raw.trim();
		if (!name || matched.has(name)) continue;
		const pos = body.indexOf(name.toLowerCase());
		if (pos !== -1) {
			hits.push({ name, pos });
			matched.add(name);
		}
	}
	// 按正文出现位置排序（去重已在 matched 保证）
	hits.sort((a, b) => a.pos - b.pos);
	return hits.map((h) => h.name);
}

/**
 * 在正文中检出在场角色（含别名）：每个 known 的 name + aliases 全部按长度降序
 * 匹配正文（长名优先防子串误伤，大小写不敏感），任一命中即算该角色在场；
 * 位置取该角色全部候选的最早命中位（保证「按正文出现顺序」）。
 *
 * known 里 hidden 的角色剔除。返回按正文出现顺序去重的主名（name）列表。
 */
export function detectPresentCharactersWithAliases(
	text: string,
	known: Array<{ name: string; aliases?: string[] }>,
): string[] {
	const body = (text ?? "").toLowerCase();
	if (!body) return [];
	if (!Array.isArray(known) || known.length === 0) return [];

	// 每个 known：name + aliases 收集为候选串；hidden 剔除
	const candidates: { name: string; token: string }[] = [];
	for (const k of known) {
		if (!k || typeof k !== "object") continue;
		if (k.hidden === true) continue;
		const name = typeof k.name === "string" ? k.name.trim() : "";
		if (!name) continue;
		candidates.push({ name, token: name });
		if (Array.isArray(k.aliases)) {
			for (const a of k.aliases) {
				if (typeof a === "string" && a.trim()) candidates.push({ name, token: a.trim() });
			}
		}
	}
	if (candidates.length === 0) return [];

	// 长名优先（防短别名命中长主名子串；同一角色多个候选合并取最早位）
	candidates.sort((a, b) => b.token.length - a.token.length);

	const minPos = new Map<string, number>();
	for (const c of candidates) {
		const pos = body.indexOf(c.token.toLowerCase());
		if (pos !== -1) {
			const cur = minPos.get(c.name);
			if (cur === undefined || pos < cur) minPos.set(c.name, pos);
		}
	}
	const hits = [...minPos.entries()].map(([name, pos]) => ({ name, pos }));
	// 按正文出现位置排序
	hits.sort((a, b) => a.pos - b.pos);
	return hits.map((h) => h.name);
}
