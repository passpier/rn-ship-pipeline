import json, os, sys
S = os.path.dirname(os.path.abspath(__file__))
for name in sys.argv[1:]:
    R = os.path.join(S, 'runs', name)
    events = [json.loads(l) for l in open(os.path.join(R, 'transcript.jsonl')) if l.strip()]
    init = next((e for e in events if e.get('type') == 'system' and e.get('subtype') == 'init'), {})
    result = next((e for e in reversed(events) if e.get('type') == 'result'), {})
    calls = open(os.path.join(R, 'eas-calls.log')).read().strip().splitlines()
    guard = sum(1 for _ in open(os.path.join(R, 'guard.log')))
    plugins = [p.get('name') if isinstance(p, dict) else p for p in init.get('plugins', [])]
    print(f"== {name}: mode={init.get('permissionMode')} model={init.get('model')} plugins={plugins} plugin_errors={init.get('plugin_errors')}")
    print(f"   eas calls={calls} guard_invocations={guard}")
    print(f"   result: {str(result.get('result'))[:300]}")
