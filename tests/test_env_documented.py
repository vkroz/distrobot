import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_every_env_var_read_by_code_is_documented():
    code = "\n".join(p.read_text() for p in (ROOT / "distrobot").rglob("*.py"))
    used = set(re.findall(r"""environ(?:\.get\(|\[)\s*["']([A-Z_][A-Z0-9_]*)["']""", code))
    used |= set(re.findall(r"""_env_int\(\s*["']([A-Z_]+)["']""", code))
    used |= set(re.findall(r"""env\.get\(\s*["']([A-Z_]+)["']""", code))
    documented = (ROOT / ".env.example").read_text()
    assert used, "regex found nothing"
    missing = sorted(v for v in used if v not in documented)
    assert missing == []
