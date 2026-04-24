import express from "express";
const app = express();
const r1 = express.Router(); r1.get("/x", (_q,_s)=>{});
app.use("/admin", r1);
app.get("/health", (_q,_s)=>{});
const stack = app.router?.stack || app._router?.stack || [];
for (const l of stack) {
  console.log("layer keys:", Object.keys(l));
  console.log("layer JSON:", JSON.stringify({
    name: l.name, path: l.path, route_path: l.route?.path,
    matchers: l.matchers ? "present" : undefined,
    handle_stack_len: l.handle?.stack?.length,
  }));
  // Print all own props
  for (const k of Object.keys(l)) {
    const v = l[k];
    if (typeof v === "function") continue;
    console.log("  ", k, "=", typeof v, "→", typeof v === "object" ? Object.keys(v||{}) : String(v).slice(0,200));
  }
  console.log("---");
}
