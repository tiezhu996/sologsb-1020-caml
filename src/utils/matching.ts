import type { ArchiveRecord, FieldKey, MatchCandidate } from '../types';

const normalize = (value: string) => value.toLowerCase().replace(/[\s·,，。:：;；()（）\-_/]/g, '');
const chars = (value: string) => {
  const text = normalize(value);
  if (text.length < 2) return [text];
  return Array.from({ length: text.length - 1 }, (_, index) => text.slice(index, index + 2));
};
const dice = (left: string, right: string) => {
  const a = chars(left);
  const b = chars(right);
  if (!a.length || !b.length) return 0;
  const remaining = [...b];
  let hits = 0;
  a.forEach((item) => {
    const index = remaining.indexOf(item);
    if (index >= 0) { hits += 1; remaining.splice(index, 1); }
  });
  return (2 * hits) / (a.length + b.length);
};
const jaccard = (left: string[], right: string[]) => {
  const a = new Set(left.map(normalize));
  const b = new Set(right.map(normalize));
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  a.forEach((item) => { if (b.has(item)) intersection += 1; });
  return intersection / (a.size + b.size - intersection);
};
const exactish = (left: string, right: string) => {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length) + 0.15;
  return dice(a, b);
};
const displayValue = (record: ArchiveRecord, field: FieldKey) => {
  const value = record[field];
  return Array.isArray(value) ? value.join('、') : String(value);
};

export function scorePair(left: ArchiveRecord, right: ArchiveRecord) {
  const fieldScores: Record<FieldKey, number> = {
    title: exactish(left.title, right.title),
    date: exactish(left.date, right.date),
    people: jaccard(left.people, right.people),
    places: jaccard(left.places, right.places),
    identifier: exactish(left.identifier, right.identifier),
    medium: exactish(left.medium, right.medium),
    extent: exactish(left.extent, right.extent),
    rights: exactish(left.rights, right.rights),
    notes: exactish(left.notes, right.notes)
  };
  const score = fieldScores.title * .3 + fieldScores.date * .2 + fieldScores.people * .2 + fieldScores.places * .14 + fieldScores.identifier * .16;
  const reasons: string[] = [];
  if (fieldScores.identifier > .8) reasons.push('编号高度一致');
  if (fieldScores.title > .58) reasons.push('标题相似');
  if (fieldScores.date > .9) reasons.push('日期一致');
  if (fieldScores.people > .8) reasons.push('人物一致');
  if (fieldScores.places > .6) reasons.push('地点相近');
  if (!reasons.length) reasons.push('组合字段达到匹配阈值');
  return { score: Math.min(1, score), fieldScores, reasons };
}

export function computeMatches(records: ArchiveRecord[], previous: MatchCandidate[] = []): MatchCandidate[] {
  const pairKey = (leftId: string, rightId: string) => `${leftId}|${rightId}`;

  // 已有结论（确认 / 忽略 / 合并）的匹配原样保留，重新匹配不改变其状态
  const concluded = previous.filter((match) => match.status !== 'suggested');
  const concludedPairs = new Set(concluded.map((match) => pairKey(match.leftId, match.rightId)));

  // 已确认或已合并的记录视为已占用，不再参与新一轮配对
  const locked = new Set<string>();
  concluded.forEach((match) => {
    if (match.status === 'confirmed' || match.status === 'merged') {
      locked.add(match.leftId);
      locked.add(match.rightId);
    }
  });

  const left = records.filter((record) => record.group === 'A' && !locked.has(record.id));
  const right = records.filter((record) => record.group === 'B' && !locked.has(record.id));
  const pool: Array<{ leftId: string; rightId: string; score: number; fieldScores: Record<FieldKey, number>; reasons: string[] }> = [];
  left.forEach((a) => {
    right.forEach((b) => {
      if (concludedPairs.has(pairKey(a.id, b.id))) return;
      const scored = scorePair(a, b);
      if (scored.score >= .38) pool.push({ leftId: a.id, rightId: b.id, ...scored });
    });
  });

  // 按分数从高到低一对一贪心配对，每份记录只出现在一条候选里
  pool.sort((x, y) => y.score - x.score);
  const usedLeft = new Set<string>();
  const usedRight = new Set<string>();
  const fresh: MatchCandidate[] = [];
  pool.forEach((candidate) => {
    if (usedLeft.has(candidate.leftId) || usedRight.has(candidate.rightId)) return;
    usedLeft.add(candidate.leftId);
    usedRight.add(candidate.rightId);
    fresh.push({
      id: `match-${candidate.leftId}-${candidate.rightId}`,
      leftId: candidate.leftId,
      rightId: candidate.rightId,
      score: candidate.score,
      fieldScores: candidate.fieldScores,
      status: 'suggested',
      reasons: candidate.reasons
    });
  });

  return [...concluded, ...fresh].sort((a, b) => b.score - a.score);
}

export function fieldValue(record: ArchiveRecord, field: FieldKey): string {
  return displayValue(record, field);
}
