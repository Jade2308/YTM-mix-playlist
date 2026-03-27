#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import argparse
import csv
import re
import sys
from typing import Dict, List, Tuple

import requests

YOUTUBE_API = "https://www.googleapis.com/youtube/v3"
BAD_TITLES = {"Private video", "Deleted video"}


def extract_playlist_id(s: str) -> str:
    s = (s or "").strip()
    if not s:
        raise ValueError("Playlist trống.")
    m = re.search(r"[?&]list=([a-zA-Z0-9_-]+)", s)
    if m:
        return m.group(1)
    if re.fullmatch(r"[a-zA-Z0-9_-]+", s):
        return s
    raise ValueError(f"Không đọc được playlistId từ: {s}")


def yt_get(path: str, params: Dict) -> Dict:
    url = f"{YOUTUBE_API}/{path}"
    r = requests.get(url, params=params, timeout=30)
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:500]}")
    return r.json()


def fetch_playlist_items(api_key: str, playlist_id: str, label: str) -> List[Dict]:
    out = []
    page_token = None

    while True:
        data = yt_get(
            "playlistItems",
            {
                "part": "snippet,contentDetails",
                "playlistId": playlist_id,
                "maxResults": 50,
                "pageToken": page_token,
                "key": api_key,
            },
        )

        for it in data.get("items", []):
            sn = it.get("snippet", {}) or {}
            cd = it.get("contentDetails", {}) or {}

            out.append(
                {
                    "playlist": label,
                    "playlistId": playlist_id,
                    "playlistItemId": it.get("id", ""),
                    "videoId": cd.get("videoId", ""),
                    "title": sn.get("title", "") or "",
                }
            )

        page_token = data.get("nextPageToken")
        if not page_token:
            break

    return out


def chunked(lst: List[str], n: int):
    for i in range(0, len(lst), n):
        yield lst[i : i + n]


def fetch_video_status_map(api_key: str, video_ids: List[str]) -> Dict[str, Dict]:
    status_map = {}
    for part_ids in chunked(video_ids, 50):
        data = yt_get(
            "videos",
            {
                "part": "status,snippet",
                "id": ",".join(part_ids),
                "maxResults": 50,
                "key": api_key,
            },
        )
        for v in data.get("items", []):
            status_map[v["id"]] = v
    return status_map


def detect_problematic(items: List[Dict], status_map: Dict[str, Dict]) -> Tuple[List[Dict], List[Dict]]:
    bad, good = [], []

    for x in items:
        vid = x["videoId"]
        title = x["title"]
        reasons = []

        if not vid:
            reasons.append("playlist item không có videoId")
        if title in BAD_TITLES:
            reasons.append(f"title='{title}'")
        if vid and vid not in status_map:
            reasons.append("Video not found / private / deleted (videos.list không trả về)")

        if reasons:
            row = dict(x)
            row["reason"] = "; ".join(reasons)
            bad.append(row)
        else:
            good.append(x)

    return bad, good


def save_csv(path: str, rows: List[Dict], headers: List[str]):
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=headers)
        w.writeheader()
        w.writerows(rows)


def main():
    p = argparse.ArgumentParser(
        description="Quét 2 playlist YouTube để tìm bài có nguy cơ lỗi khi trộn."
    )
    p.add_argument("--api-key", required=True, help="YouTube Data API v3 key")
    p.add_argument("--playlist-a", required=True, help="Playlist A (link hoặc ID)")
    p.add_argument("--playlist-b", required=True, help="Playlist B (link hoặc ID)")
    p.add_argument("--out-bad", default="bad_songs.csv", help="CSV chứa bài lỗi")
    p.add_argument("--out-good", default="good_video_ids.txt", help="TXT videoId an toàn")
    args = p.parse_args()

    try:
        a_id = extract_playlist_id(args.playlist_a)
        b_id = extract_playlist_id(args.playlist_b)

        a_items = fetch_playlist_items(args.api_key, a_id, "A")
        b_items = fetch_playlist_items(args.api_key, b_id, "B")
        all_items = a_items + b_items

        all_ids = sorted({x["videoId"] for x in all_items if x["videoId"]})
        status_map = fetch_video_status_map(args.api_key, all_ids)

        bad, good = detect_problematic(all_items, status_map)

        # In màn hình theo format giống bạn muốn
        print(f"Đã quét: A={len(a_items)} bài, B={len(b_items)} bài, tổng={len(all_items)}")
        print(f"⚠️ Bài có thể bị lỗi ({len(bad)}):")
        for i, row in enumerate(bad, 1):
            vid = row["videoId"] or "<no-video-id>"
            title = row["title"] or "<no-title>"
            print(f"{i:>3}. {vid} — {title} | {row['reason']}")

        # CSV lỗi để lọc
        save_csv(
            args.out_bad,
            bad,
            headers=["playlist", "playlistId", "playlistItemId", "videoId", "title", "reason"],
        )

        # TXT id an toàn (unique)
        safe_ids = []
        seen = set()
        for x in good:
            vid = x["videoId"]
            if vid and vid not in seen:
                seen.add(vid)
                safe_ids.append(vid)

        with open(args.out_good, "w", encoding="utf-8") as f:
            f.write("\n".join(safe_ids))

        print(f"\nĐã lưu danh sách lỗi: {args.out_bad}")
        print(f"Đã lưu videoId an toàn: {args.out_good}")

    except Exception as e:
        print(f"Lỗi: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()