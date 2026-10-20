export function lyricTrackKey(track) {
  return track ? `${track.source}:${track.sourceTrackId}` : "";
}

export function lyricLookupKey(track) {
  const key = lyricTrackKey(track);
  if (!key || track.source !== "device") return key;
  return `${key}:${JSON.stringify([track.title || "", track.artist || ""])}`;
}

export function activeLyricIndex(lines, positionMs) {
  const position = Number.isFinite(positionMs) ? positionMs : 0;
  let active = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].timeMs <= position) active = i;
    else break;
  }
  return active;
}
