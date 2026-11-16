import ts from "typescript";

/** Convert a deliberately bounded Playwright Test recording without executing it.
 * Unsupported constructs fail the entire conversion, never a partial flow. */
export function convertRecording(source: string, options: { app: string; name: string; baseUrl: string }) {
  if (Buffer.byteLength(source) > 256_000) throw new Error("Recording exceeds 256 KB");
  const base = new URL(options.baseUrl);
  if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("Expected a credential-free HTTP(S) base URL");
  const sf = ts.createSourceFile("recording.ts", source, ts.ScriptTarget.Latest, true);
  if ((sf as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) throw new Error("Invalid recording syntax; no flow written");
  const fail = (n: ts.Node): never => { throw new Error(`Unsupported recording syntax at line ${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}; no flow written`); };
  const literal = (n: ts.Expression): string => {
    if (ts.isStringLiteral(n)) return JSON.stringify(n.text);
    if (ts.isNumericLiteral(n) && Number.isSafeInteger(Number(n.text))) return n.text;
    if (n.kind === ts.SyntaxKind.TrueKeyword) return "true";
    if (n.kind === ts.SyntaxKind.FalseKeyword) return "false";
    if (ts.isObjectLiteralExpression(n)) return `{${n.properties.map(p => {
      if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name) || !["name", "exact", "hasText"].includes(p.name.text)) return fail(p);
      return `${p.name.text}:${literal(p.initializer)}`;
    }).join(",")}}`;
    return fail(n);
  };
  const locator = (n: ts.Expression): string => {
    if (ts.isIdentifier(n) && n.text === "page") return "page";
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return fail(n);
    const method = n.expression.name.text;
    if (!["getByRole", "getByText", "getByLabel", "getByPlaceholder", "getByTestId", "getByAltText", "getByTitle", "locator", "filter", "nth", "first", "last"].includes(method)) return fail(n);
    return `${locator(n.expression.expression)}.${method}(${n.arguments.map(literal).join(",")})`;
  };
  const bodies: ts.Block[] = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      if (!ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== "@playwright/test") fail(st);
      continue;
    }
    if (!ts.isExpressionStatement(st) || !ts.isCallExpression(st.expression) || !ts.isIdentifier(st.expression.expression) || st.expression.expression.text !== "test") fail(st);
    const call = (st as ts.ExpressionStatement).expression as ts.CallExpression;
    const callback = call.arguments[1];
    if (call.arguments.length !== 2 || !ts.isStringLiteral(call.arguments[0]) || !callback || !ts.isArrowFunction(callback) || !ts.isBlock(callback.body)) fail(st);
    const fn = callback as ts.ArrowFunction;
    if (fn.parameters.length !== 1 || fn.parameters[0].name.getText(sf).replace(/\s/g, "") !== "{page}" || fn.parameters[0].initializer) fail(fn);
    bodies.push(fn.body as ts.Block);
  }
  if (bodies.length !== 1) throw new Error("Expected exactly one Playwright Test recording");
  const variables: string[] = [];
  const actions: string[] = [];
  let assertions = false;
  for (const st of bodies[0].statements) {
    if (!ts.isExpressionStatement(st) || !ts.isAwaitExpression(st.expression) || !ts.isCallExpression(st.expression.expression)) fail(st);
    const call = ((st as ts.ExpressionStatement).expression as ts.AwaitExpression).expression as ts.CallExpression;
    if (!ts.isPropertyAccessExpression(call.expression)) fail(call);
    const prop = call.expression as ts.PropertyAccessExpression;
    const method = prop.name.text;
    let action: string;
    const negated = ts.isPropertyAccessExpression(prop.expression) && prop.expression.name.text === "not";
    const subject = negated ? (prop.expression as ts.PropertyAccessExpression).expression : prop.expression;
    if (ts.isCallExpression(subject) && ts.isIdentifier(subject.expression) && subject.expression.text === "expect") {
      const zero = ["toBeVisible", "toBeHidden", "toBeEnabled", "toBeDisabled", "toBeChecked", "toBeEmpty"];
      const one = ["toHaveText", "toContainText", "toHaveValue", "toHaveCount", "toHaveURL", "toHaveTitle"];
      if (subject.arguments.length !== 1 || (!zero.includes(method) && !one.includes(method)) || call.arguments.length !== (zero.includes(method) ? 0 : 1)) fail(call);
      let argument = call.arguments.map(literal).join(",");
      if (method === "toHaveURL") {
        if (!ts.isStringLiteral(call.arguments[0])) fail(call);
        const expected = new URL((call.arguments[0] as ts.StringLiteral).text, base);
        if (expected.origin !== base.origin || expected.username || expected.password || expected.search || expected.hash) throw new Error("URL assertions must use the configured origin without query/fragment credentials");
        argument = JSON.stringify(expected.href);
      }
      if (method === "toHaveValue") {
        if (!ts.isStringLiteral(call.arguments[0])) fail(call);
        const key = `QA_FLOW_INPUT_${variables.length + 1}`; variables.push(key);
        argument = `input(${JSON.stringify(key)})`;
      }
      assertions = true;
      action = `expect(${locator(subject.arguments[0])})${negated ? ".not" : ""}.${method}(${argument})`;
    } else if (method === "goto" && ts.isIdentifier(prop.expression) && prop.expression.text === "page") {
      if (call.arguments.length !== 1 || !ts.isStringLiteral(call.arguments[0])) fail(call);
      const target = new URL((call.arguments[0] as ts.StringLiteral).text, base);
      if (target.origin !== base.origin || target.username || target.password || target.search || target.hash) throw new Error("Recording navigation must stay on the configured origin without query/fragment credentials");
      action = `page.goto(${JSON.stringify(target.href)})`;
    } else if (method === "fill") {
      if (call.arguments.length !== 1 || !ts.isStringLiteral(call.arguments[0])) fail(call);
      const key = `QA_FLOW_INPUT_${variables.length + 1}`;
      variables.push(key);
      action = `${locator(prop.expression)}.fill(input(${JSON.stringify(key)}))`;
    } else {
      if (!["click", "dblclick", "check", "uncheck", "press"].includes(method)) fail(call);
      if (method === "press" ? call.arguments.length !== 1 : call.arguments.length !== 0) fail(call);
      action = `${locator(prop.expression)}.${method}(${call.arguments.map(literal).join(",")})`;
    }
    actions.push(`    await step(${JSON.stringify(`Recorded action ${actions.length + 1}`)}, () => ${action});`);
  }
  if (!actions.length) throw new Error("Recording has no actions");
  return { variables, source: `// Review recorded actions before running. Fill/value assertions use environment inputs.\nconst input = (key) => { const value = process.env[key]; if (value === undefined) throw new Error('Missing flow input: ' + key); return value; };\nexport default {\n  name: ${JSON.stringify(options.name)}, app: ${JSON.stringify(options.app)}, login: false, writes: true,\n  async run({ page, step${assertions ? ", expect" : ""} }) {\n${actions.join("\n")}\n  }\n};\n` };
}
