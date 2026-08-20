// server/import-merge.mjs
// 「重新导入时如何对待用户的手工修改」的统一裁决逻辑，两条导入链路
//（newapi-token-plan.mjs / sub2api-plan.mjs）共用同一份实现。
//
// 【为什么需要它】原先重新导入是 `{...prev, ...mapped}` 全量覆盖，后果是产品自己的指引会被自己推翻：
// 渠道 notes 明写「若测试报 404 请把协议改为 OpenAI Compatible」，用户照做，下次导入协议被静默改回，
// 名字和手加的模型一并消失，而 summary 只说「更新 N 个」，不提覆盖了什么。
//
// 【做法：三方合并】存一份 importSnapshot = 上一次导入时上游给的值。再导入时逐字段比对：
//   prev === snapshot  → 用户没动过这个字段 → 采纳上游的新值（上游改名/换协议仍能同步过来）
//   prev !== snapshot  → 用户改过 → 保留用户的值，并计入 preserved 上报
// 只有三方比对能同时满足这两个诉求；只看「prev 与上游是否不同」是分不出「用户改过」和「上游改了」的。
//
// 【老渠道没有 snapshot 怎么办】本功能上线前导入的渠道没有这个字段，此时无从判断用户是否改过。
// 选择「保守保留本地值」——宁可让一次上游改名同步不过来（用户可自行改），也不要静默抹掉用户的修改
// （那是不可逆的数据丢失，且用户不会收到任何提示）。同时把 snapshot 补写成上游当前值，
// 于是下一次导入起三方比对即生效：用户没改过的字段此后能正常跟随上游。
// 无可用快照时的哨兵：用一个固定的空对象，使 snapshot[field] 恒为 undefined，
// 配合 hasSnapshot=false 走保守保留分支。
const EMPTY = Object.freeze({});

// 参与三方比对的标量字段。**改这个清单前先想清楚**：不在这里的字段一律被上游全量覆盖，
// 而"用户在 UI 里能改的字段"就是这份清单该覆盖的范围（渠道表单见 index.html #channel-form）。
// 自查时实测过漏项的后果：只保护 name/protocol 时，用户填的 provider 和自己写的 notes
// 每次重新导入都被静默冲掉——与本模块要修的原始 bug 是同一类问题，只是换了字段。
//   · name / protocol / provider / notes —— 表单里有控件，用户改得到，必须保护。
//   · models —— 单独走集合合并（见 mergeModels），不在标量清单里。
//   · status —— **刻意不保护**：渠道表单里没有该控件，前端也没有任何提交 status 的代码
//     （normalizeChannel 用 `body.status ?? existing?.status` 沿用现值），故上游是它唯一的权威来源；
//     把它纳入保护反而会让"上游已停用的渠道"在本地一直显示启用。
//   · baseUrl —— 同样不保护：它由 base + 上游身份决定，改了就不是同一个渠道了。
export const MERGED_SCALAR_FIELDS = Object.freeze(["name", "protocol", "provider", "notes"]);

/**
 * 由本次导入映射出的渠道生成快照。**首次导入也必须写**——否则第二次导入时
 * hasSnapshot=false，会被当成"本功能上线前的老渠道"而走保守保留分支，
 * 上游改名/换协议永远同步不过来（实测：这正是漏写时的表现，原有的
 * 「命中已存在渠道时保留其 id」用例会因名称不更新而红）。
 */
export function importSnapshotOf(mapped) {
  const snap = { models: Array.isArray(mapped?.models) ? [...mapped.models] : [] };
  for (const field of MERGED_SCALAR_FIELDS) snap[field] = mapped?.[field];
  return snap;
}

/**
 * 快照是否可用于三方比对。**按形状判，不能只判 `typeof === "object"`**：
 * `{}` 和 `[]` 都是 object，若当成"有快照"，逐字段比对 `undefined !== 本地值` 会把每个字段
 * 都判成"用户改过"→ 永久保留 → 上游改名再也同步不过来（实测确认过这个表现）。
 * `normalizeChannel` 不校验该字段形状、原样收下请求体里的 `importSnapshot`，所以 `{}` 是可达的。
 * 判据取"至少有一个我们关心的键存在"，缺形状即回落到保守保留分支（与老渠道同路，安全侧）。
 */
export function isUsableSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
  if (Object.hasOwn(snapshot, "models")) return true;
  return MERGED_SCALAR_FIELDS.some((field) => Object.hasOwn(snapshot, field));
}

// 单个标量字段的三方裁决。返回 { value, preserved }。
export function mergeScalar({ upstream, prev, snapshot, hasSnapshot }) {
  // 没有历史快照：保守保留本地已有值（仅当本地确实有值时）。
  if (!hasSnapshot) {
    const keep = prev !== undefined && prev !== null && prev !== "";
    return { value: keep ? prev : upstream, preserved: keep && prev !== upstream };
  }
  // 本地值仍等于上次导入的值 → 用户没动过 → 跟随上游。
  if (prev === snapshot) return { value: upstream, preserved: false };
  // 用户改过 → 保留，并上报。
  return { value: prev, preserved: true };
}

// 模型清单的三方集合合并。用户可能删掉了不想测的模型、也可能手加了上游没有的模型，
// 两种意图都要保住，同时上游【新增】的模型仍要能进来。
//   userRemoved = snapshot - prev  （上次导入有、现在本地没有 → 用户删的，别再加回来）
//   userAdded   = prev - snapshot  （本地有、上次导入没有 → 用户加的，别被抹掉）
//   结果 = (上游 - userRemoved) ∪ userAdded，上游顺序在前、用户追加在后
// 无快照时同样保守：并集（不删任何本地已有的），避免抹掉用户手加的模型。
export function mergeModels({ upstream, prev, snapshot, hasSnapshot }) {
  const up = Array.isArray(upstream) ? upstream : [];
  const before = Array.isArray(prev) ? prev : [];
  const snap = Array.isArray(snapshot) ? snapshot : [];
  if (!hasSnapshot) {
    const merged = [...up, ...before.filter((m) => !up.includes(m))];
    return { value: dedupe(merged), preserved: before.some((m) => !up.includes(m)) };
  }
  const userRemoved = new Set(snap.filter((m) => !before.includes(m)));
  const userAdded = before.filter((m) => !snap.includes(m));
  const kept = up.filter((m) => !userRemoved.has(m));
  const merged = dedupe([...kept, ...userAdded.filter((m) => !kept.includes(m))]);
  return { value: merged, preserved: userRemoved.size > 0 || userAdded.length > 0 };
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const name = String(item ?? "").trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * 合并一个已存在渠道与本次导入映射出的新值。
 *
 * @param {object} prev     库里已有的渠道
 * @param {object} mapped   本次导入按上游数据映射出的渠道（上游口径）
 * @param {string[]} scalarFields 参与三方比对的标量字段，默认 MERGED_SCALAR_FIELDS
 * @returns {{channel: object, preservedFields: string[]}}
 *   channel 含更新后的 importSnapshot；preservedFields 是被保留的用户修改字段名（供上报）。
 */
export function mergeImportedChannel(prev, mapped, scalarFields = MERGED_SCALAR_FIELDS) {
  const raw = prev?.importSnapshot;
  const hasSnapshot = isUsableSnapshot(raw);
  const snapshot = hasSnapshot ? raw : EMPTY;
  const preservedFields = [];
  const merged = { ...prev, ...mapped };

  for (const field of scalarFields) {
    const { value, preserved } = mergeScalar({
      upstream: mapped[field],
      prev: prev?.[field],
      snapshot: snapshot[field],
      hasSnapshot,
    });
    merged[field] = value;
    if (preserved) preservedFields.push(field);
  }

  const models = mergeModels({
    upstream: mapped.models,
    prev: prev?.models,
    snapshot: snapshot.models,
    hasSnapshot,
  });
  merged.models = models.value;
  if (models.preserved) preservedFields.push("models");

  // 快照始终记【上游本次给的值】，与合并结果无关——它的语义是「上游上次说了什么」，
  // 写成合并结果会让下次比对永远判定"用户没改过"，三方合并退化成全量覆盖。
  merged.importSnapshot = importSnapshotOf(mapped);

  // id 与创建时间永远沿用本地（导入不该改变对象身份）。
  merged.id = prev?.id ?? mapped.id;
  merged.createdAt = prev?.createdAt || mapped.createdAt;
  return { channel: merged, preservedFields };
}

/**
 * 协议被用户改过时，重新生成的 notes 会与实际协议对不上（notes 说"按 platform 判定"，
 * 而实际协议是用户改的）。这里在 notes 末尾补一句实话，避免读 notes 的人被误导。
 */
export function annotatePreservedProtocol(notes, { preserved, upstreamProtocol, actualProtocol }) {
  if (!preserved || upstreamProtocol === actualProtocol) return notes;
  return `${notes}【已保留你的手工设置】本次导入未改动协议：上游口径为 ${upstreamProtocol}，当前保持你设置的 ${actualProtocol}。`;
}

/**
 * notes 的收尾处理。**必须走这里，不要在 plan 里直接赋值 mergedChannel.notes**——
 * 那样会踩两个坑（自查时实测过）：
 *   1) 无条件覆写会把【用户自己写的备注】冲掉，等于 notes 这个字段没被三方合并保护；
 *   2) 追加了协议说明后，落库的 notes 就不等于 importSnapshot.notes 了，下一次导入会把这段
 *      由程序自己追加的文字误判成"用户改过 notes"，从此 notes 永久保留、再也不跟随上游。
 * 故：用户改过 notes 就完全不碰；没改过才重新生成（含协议说明），并把快照同步成
 * 【本次导入实际产出的 notes】，使下一次比对仍能正确判断。
 */
export function finalizeImportedNotes(channel, preservedFields, { upstreamNotes, upstreamProtocol }) {
  if (preservedFields.includes("notes")) return channel; // 用户写了自己的备注，原样保留
  const notes = annotatePreservedProtocol(upstreamNotes, {
    preserved: preservedFields.includes("protocol"),
    upstreamProtocol,
    actualProtocol: channel.protocol,
  });
  channel.notes = notes;
  if (channel.importSnapshot) channel.importSnapshot.notes = notes;
  return channel;
}
