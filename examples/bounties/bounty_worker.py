"""Select bounties from Python (ZerePy, Swarms or any agent): list open microtasks, build the exact artifact,
check it against the published hash, and (optionally) sign the claim with a Solana keypair.

    python3 examples/bounties/bounty_worker.py                    # list open items
    python3 examples/bounties/bounty_worker.py 7                  # item 7 → out.json + hash check
    python3 examples/bounties/bounty_worker.py 7 --wallet ~/.config/solana/id.json --project my-agent
                                                                  # … + signed claim (pip install pynacl base58)

2 USDC per item on Solana mainnet, sponsored by Select; max 3 paid per project; reviewed within 24 h.
Guide: https://api.tryaigility.com/bounties · machine-readable: GET /v2/bounties → guide
"""
import argparse, csv, hashlib, json, os, time, urllib.request, uuid

API = os.environ.get("SELECT_API", "https://api.tryaigility.com")


def get(url):
    with urllib.request.urlopen(url, timeout=20) as r:
        return r.read()


def transform(text):
    """Reference transform (byte-exact): sorted keys, trimmed string values, compact JSON, UTF-8."""
    rows = list(csv.reader([l for l in text.replace("\r\n", "\n").split("\n") if l]))
    header = [h.strip() for h in rows[0]]
    out = [{k: r[header.index(k)].strip() for k in sorted(header)} for r in rows[1:]]
    return json.dumps(out, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("item", nargs="?")
    ap.add_argument("--wallet")
    ap.add_argument("--project", default="my-agent")
    a = ap.parse_args()
    items = [i for i in json.loads(get(f"{API}/v2/bounties"))["items"] if i["status"] == "open" and i.get("input")]
    if not a.item:
        for i in items:
            print(i["id"], i["reward"], "USDC", i["input"]["url"])
        print(len(items), "open")
        return
    item = next((i for i in items if i["id"].endswith(f":{a.item}")), None)
    if not item:
        raise SystemExit(f"item {a.item} is not open")
    data = get(item["input"]["url"])
    assert hashlib.sha256(data).hexdigest() == item["input"]["sha256"], "input hash mismatch"
    artifact = transform(data.decode("utf-8"))
    h = hashlib.sha256(artifact).hexdigest()
    open("out.json", "wb").write(artifact)
    print(f"out.json written ({len(artifact)} bytes), sha256 {h},", "MATCHES" if h == item["expectedOutputSha256"] else "does NOT match")
    if a.wallet and h == item["expectedOutputSha256"]:
        import base58
        from nacl.signing import SigningKey
        key = SigningKey(bytes(json.load(open(os.path.expanduser(a.wallet))))[:32])
        nonce, expires_at = uuid.uuid4().hex, int(time.time()) + 12 * 3600
        msg = f"rufus-bounty-claim:v1:rufus-bounties-2026q4:{item['id']}:{a.project}:{nonce}:{expires_at}".encode()
        claim = {"bountyId": item["id"], "project": a.project, "wallet": base58.b58encode(bytes(key.verify_key)).decode(),
                 "nonce": nonce, "expiresAt": expires_at, "signature": base58.b58encode(key.sign(msg).signature).decode()}
        print(f'\nOpen an issue titled "Bounty claim {item["id"]}" at https://github.com/SiiahK/rufus-agent-adapters/issues with out.json and:')
        print(json.dumps(claim, indent=2))


if __name__ == "__main__":
    main()
