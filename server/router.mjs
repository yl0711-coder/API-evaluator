// 路由表：把「本服务有哪些接口」从 handleApi 那条 1100 行 if 链里的隐含状态，
// 变成一张可读、可测、可一眼看完的清单。
//
// 为什么不引框架（Express 等）：本服务替用户保管中转站 API key，任何插进请求路径的
// 第三方依赖都是供应链风险面；而 handleApi 里真正难的部分（鉴权中间件 api-access.mjs、
// 业务逻辑 server/*.mjs）早已抽离，剩下的只是「读 body → 调模块 → sendJson」的薄分发。
// 这层用几十行自己写即可，收益（路由一览 / 顺序可见 / handler 可单测）不打折，零依赖。
//
// 匹配规则（刻意保守，与被替换的 if 链逐条等价）：
//   - 按声明顺序取第一条命中的规则，与原 if 链的短路语义一致；
//   - 路径按 "/" 分段严格比对，段数必须相等（"/api/health/"、"/api//health" 均不命中，同原精确比较）；
//   - ":name" 匹配单个非空段，并 decodeURIComponent（等价原 slice(prefix.length) + decode 的写法：
//     id 里的 "/" 客户端会编码成 %2F，URL.pathname 不解码 %2F，故单段匹配后解码结果与原写法相同）；
//   - 百分号编码非法（如 "%ZZ"）时视为不命中，交由上层兜 404，而不是让 decodeURIComponent 抛进 500。

// 把 "/api/dev/scenarios/:id" 编译成分段模板，避免手写正则的转义坑。
function compilePattern(pattern) {
  if (typeof pattern !== "string" || !pattern.startsWith("/")) {
    throw new Error(`路由模板必须是以 "/" 开头的字符串：${String(pattern)}`);
  }
  const segments = pattern.split("/").map((segment) =>
    segment.startsWith(":")
      ? { param: segment.slice(1) }
      : { literal: segment },
  );
  for (const segment of segments) {
    if (segment.param === "") throw new Error(`路由模板的参数缺少名字：${pattern}`);
  }
  return segments;
}

function decodeSegment(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null; // 非法百分号编码：不命中
  }
}

// 单条规则匹配：命中返回 params 对象（无参数时为空对象），未命中返回 null。
function matchPattern(segments, pathname) {
  const parts = pathname.split("/");
  if (parts.length !== segments.length) return null;

  const params = {};
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const part = parts[i];
    if (segment.literal !== undefined) {
      if (segment.literal !== part) return null;
      continue;
    }
    if (part === "") return null; // 参数段不接受空值（"/api/dev/scenarios/"）
    const value = decodeSegment(part);
    if (value === null) return null;
    params[segment.param] = value;
  }
  return params;
}

// routes: [method, pattern, handler] 三元组数组，按声明顺序匹配。
// 返回 { match(method, pathname), list() }。
export function createRouter(routes) {
  const compiled = routes.map(([method, pattern, handler], index) => {
    if (typeof handler !== "function") {
      throw new Error(`路由 ${method} ${pattern} 的 handler 不是函数`);
    }
    return { method: method.toUpperCase(), pattern, segments: compilePattern(pattern), handler, index };
  });

  // 完全重复的 (method, pattern) 只有第一条会生效，后面的是死代码：启动即报错，别等线上查。
  const seen = new Set();
  for (const route of compiled) {
    const key = `${route.method} ${route.pattern}`;
    if (seen.has(key)) throw new Error(`路由表存在重复规则：${key}`);
    seen.add(key);
  }

  // 顺序体检：被前面更宽的规则完全遮住的后置规则永远不会命中。这正是原 if 链最难查的坑
  // （不报错、不警告，安静走进错误分支），故在建表时就打死，让它变成启动失败而非线上疑案。
  const shadowed = findShadowedRoutes(routes);
  if (shadowed.length > 0) {
    const detail = shadowed.map((c) => `${c.shadowed} 被 ${c.by} 遮蔽`).join("；");
    throw new Error(`路由表顺序有误（更精确的规则须排在带参数的宽规则之前）：${detail}`);
  }

  return {
    match(method, pathname) {
      const wanted = String(method || "").toUpperCase();
      for (const route of compiled) {
        if (route.method !== wanted) continue;
        const params = matchPattern(route.segments, pathname);
        if (params) return { handler: route.handler, params, pattern: route.pattern };
      }
      return null;
    },
    list() {
      return compiled.map(({ method, pattern }) => ({ method, pattern }));
    },
  };
}

// 顺序体检：找出被前面更宽的规则完全遮住、永远不会命中的后置规则。
// 现在的 if 链里，这种「截胡」是静默的（不报错，只是安静走错分支）；有了表就能测出来。
// 返回 [{ shadowed, by }]（均为 "METHOD /pattern" 字符串），空数组表示无遮蔽。
export function findShadowedRoutes(routes) {
  const compiled = routes.map(([method, pattern]) => ({
    method: method.toUpperCase(),
    pattern,
    segments: compilePattern(pattern),
  }));

  const conflicts = [];
  for (let i = 0; i < compiled.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      const later = compiled[i];
      const earlier = compiled[j];
      if (later.method !== earlier.method) continue;
      // 用后置规则的「代表路径」（参数段填一个占位值）去试前置规则：命中即说明被遮蔽。
      const probe = later.segments
        .map((segment) => (segment.literal !== undefined ? segment.literal : "__probe__"))
        .join("/");
      if (matchPattern(earlier.segments, probe)) {
        conflicts.push({ shadowed: `${later.method} ${later.pattern}`, by: `${earlier.method} ${earlier.pattern}` });
      }
    }
  }
  return conflicts;
}
