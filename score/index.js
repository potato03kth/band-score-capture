// M2 채점 진입점(순수 Node, 오프라인). data/raw/ 를 읽어 out/에 CSV+감사엑셀+unmatched를 낸다.
// 사용법: node score/index.js
const path = require('path');
const fs = require('fs');
const { loadConfig } = require('../lib/config');
const { resolveDataRoot } = require('../lib/paths');
const settingsLib = require('../lib/settings');
const scoreLogicLib = require('../lib/scoreLogic');
const parser = require('./parser');
const rules = require('./rules');
const roster = require('./roster');
const scorer = require('./scorer');
const csv = require('./csv');
const gaps = require('./gaps');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'config.jsonc');

class NoRawDataError extends Error {}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function defaultPaths(config) {
  const root = resolveDataRoot();
  return {
    input: path.join(root, config.paths?.input || 'input'),
    raw: path.join(root, config.paths?.raw || 'data/raw'),
    out: path.join(root, config.paths?.out || 'out'),
  };
}

// paths/config를 미리 계산해 넘길 수도 있다(Electron에서 재사용할 때 resolveDataRoot()를 한 번만
// 부를 수 있도록) — 안 넘기면 순수 CLI 실행처럼 스스로 계산한다.
async function runScoring({ paths, config } = {}) {
  config = config || loadConfig(CONFIG_PATH);
  paths = paths || defaultPaths(config);

  const mode = settingsLib.resolveMode();
  const settings = await settingsLib.loadSettings({ inputDir: paths.input, mode });
  console.log(
    `[score] 설정 로드 완료: 모드=${settings.mode}, ${settings.startLabel || '(전체)'} ~ ${settings.endLabel || '(전체)'}, cap=${settings.cap}, 대상 밴드 ${settings.bands.length}개`
  );

  // Phase 8: score_logic.xlsx(확장성 목적, 최하위 우선순위). 1_설정.xlsx와 달리 미기입/파일
  // 없음을 막지 않는다 — 기본값이 이미 기존 하드코딩 규칙과 100% 동일한 동작이기 때문(파일
  // 손상 시에만 중단).
  const scoreLogic = await scoreLogicLib.loadScoreLogic(paths.input);
  if (scoreLogic.created) {
    console.log(`[score] ${scoreLogicLib.SCORE_LOGIC_FILENAME}이 없어 기본값으로 새로 만들었습니다: ${scoreLogic.filePath}(전부 "변경불필요" - 기존 규칙과 동일하게 채점을 계속 진행합니다)`);
  }

  // Phase 6 게이트: 부적합 데이터(게시글총수/게시글댓글/학생댓글)가 있는데 확인 엑셀이 없으면
  // 새로 만들고 채점을 거부한다. 엑셀이 있는데 미해결(manual_value 미기입) 항목이 남아있어도
  // 마찬가지로 거부한다. 결손이 한 번도 기록된 적 없으면(파일 자체가 없음) 통과 — "결손 없음"과
  // "결손 미해결"을 혼동하지 않는다(H-3 6-3).
  const gapsCheck = await gaps.ensureGapsWorkbook(paths.input, paths.raw, settings.bands);
  if (gapsCheck.created) {
    throw new gaps.GapsValidationError(
      `부적합 데이터 확인 엑셀이 없어 새로 만들었습니다: ${gapsCheck.filePath}\n노란 칸(manual_value)을 모두 채우고 저장한 뒤 프로그램을 다시 실행하세요.`
    );
  }

  const gapsResolution = await gaps.readGapsResolution(gapsCheck.filePath);
  if (!gapsResolution.resolved) {
    const detail = Object.entries(gapsResolution.bySection)
      .map(([name, { resolved, unresolved }]) => `${name} 미해결 ${unresolved}건(해결 ${resolved}건)`)
      .join(', ');
    throw new gaps.GapsValidationError(
      `부적합 데이터 확인 엑셀에 미해결 항목이 ${gapsResolution.unresolvedCount}건 남아있습니다(${detail}). 모든 manual_value 칸을 채운 뒤 다시 실행하세요: ${gapsCheck.filePath}`
    );
  }
  if (gapsCheck.hasGaps) {
    console.log(`[score] 부적합 데이터 확인 엑셀의 모든 항목이 해결됨(${gapsCheck.filePath}) - 보정치를 반영해 진행합니다.`);
  }

  const { professorUserNos, taUserNos } = config.roles;
  const assignmentPrefixRegex = new RegExp(config.assignmentPrefixRegex);

  // 1) 후보 멤버(리더+조교 소거) 수집 → 로스터 매핑 확보(없으면 템플릿 생성, 막지 않음)
  const { candidates } = roster.collectCandidateMembers(paths.raw, settings.bands, { taUserNos });
  if (candidates.length === 0) {
    throw new NoRawDataError(
      `채점 대상 멤버를 찾을 수 없습니다. data/raw/<bandId>/_members/ 에 멤버 스냅샷이 있는지 확인하세요(acquire를 먼저 실행해야 합니다).`
    );
  }
  const { filled } = await roster.loadRosterMapping(paths.input, candidates);
  const mapping = roster.buildFinalMapping(candidates, filled);
  const syntheticCount = [...mapping.values()].filter((m) => m.mappingStatus.includes('synthetic')).length;
  if (syntheticCount > 0) {
    console.log(`[score] ${syntheticCount}명이 아직 학번 미기입 - 임시 학번(TEST####)으로 처리합니다.`);
  }

  // 2) 밴드별 raw 파싱 → 활동 필터링(측정기간 + 과제글 제외 + 소거집합 제외)
  const leaderAndTaUserNos = new Set(taUserNos);
  for (const band of settings.bands) {
    const snapshot = parser.loadLatestMemberSnapshot(paths.raw, band.bandId);
    if (!snapshot) continue;
    for (const m of snapshot.members) {
      if (m.role && m.role !== 'member') leaderAndTaUserNos.add(m.user_no);
    }
  }

  const allActivities = [];
  const bandCollectionComplete = new Map();
  const bandPostCounts = new Map();
  for (const band of settings.bands) {
    const { posts, activities } = parser.parseBandRaw(paths.raw, band.bandId);
    bandPostCounts.set(String(band.bandId), posts.size);

    const statusPath = path.join(paths.raw, String(band.bandId), 'collection_status.json');
    if (fs.existsSync(statusPath)) {
      const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      bandCollectionComplete.set(String(band.bandId), !!status.feedExhausted);
    } else {
      bandCollectionComplete.set(String(band.bandId), false);
    }

    for (const a of activities) {
      if (leaderAndTaUserNos.has(a.userNo)) continue; // 규칙7: 교수·조교 본인 활동 제외
      if (!rules.inMeasureRange(a.createdAtMs, settings)) continue; // 규칙2: 측정기간
      if (a.kind === 'comment' && !scoreLogic.includeAssignmentPosts) {
        const post = posts.get(a.postNo);
        if (rules.isAssignmentPost(post, { professorUserNos, assignmentPrefixRegex })) continue; // 규칙4(score_logic.xlsx의 과제글포함여부로 오버라이드 가능)
      }
      allActivities.push(a);
    }
  }
  console.log(`[score] 필터링 후 활동 레코드 ${allActivities.length}건(전체 ${settings.bands.length}개 밴드 합산)`);

  // 3) 채점 (일자별 채점 공식은 score_logic.xlsx로 파라미터화됨 - Phase 8)
  const scoresBeforeGapCorrection = scorer.scoreActivities(allActivities, {
    cap: settings.cap,
    dailyActivityCap: scoreLogic.dailyActivityCap,
    dailyScoreCap: scoreLogic.dailyScoreCap,
    postMultiplier: scoreLogic.postMultiplier,
    commentMultiplier: scoreLogic.commentMultiplier,
  });

  // Phase 6: 게이트를 통과한 학생댓글 보정치만 commentCount/activeDays에 반영한다(게시글총수/
  // 게시글댓글 보정은 특정 학생에게 귀속할 수 없어 점수에 반영하지 않음 - score/gaps.js 상단
  // 주석 참고). 게시글총수 보정은 밴드요약 시트의 캡처된 게시글수에만 반영한다. dailyScoreCap/
  // commentMultiplier도 함께 넘겨야 score_logic.xlsx를 커스텀했을 때 보정치도 같은 공식으로
  // 계산된다(안 넘기면 옛 기본값(1,1)으로 계산돼 커스텀 설정과 엇갈릴 수 있음).
  const scores = gaps.applyMemberCommentCorrections(scoresBeforeGapCorrection, gapsResolution.corrections.memberCommentDeltas, {
    cap: settings.cap,
    dailyScoreCap: scoreLogic.dailyScoreCap,
    commentMultiplier: scoreLogic.commentMultiplier,
  });
  const bandPostCountsFinal = gaps.applyBandPostCountOverrides(bandPostCounts, gapsResolution.corrections.bandPostCountOverrides);

  // 4) 산출
  const generatedAt = new Date().toISOString();
  const rows = csv.buildRows({ mapping, scores, cap: settings.cap, bandCollectionComplete, generatedAt });
  const bandSummaryRows = csv.buildBandSummaryRows(settings.bands, bandPostCountsFinal);

  const ts = timestamp();
  const csvPath = path.join(paths.out, `scores_${ts}.csv`);
  const xlsxPath = path.join(paths.out, `결과_및_감사_${ts}.xlsx`);
  const unmatchedPath = path.join(paths.out, `unmatched_${ts}.csv`);

  csv.writeCsv(csvPath, rows);
  await csv.writeAuditWorkbook(xlsxPath, rows, bandSummaryRows);
  const unmatchedCount = csv.writeUnmatchedCsv(unmatchedPath, rows);

  console.log(`[score] 완료 - 학생 ${rows.length}명, 점수 산출.`);
  console.log(`[score] CSV: ${csvPath}`);
  console.log(`[score] 교수용 감사 엑셀: ${xlsxPath}`);
  if (unmatchedCount > 0) {
    console.log(`[score] 학번 미확정/동명이인 ${unmatchedCount}명 - ${unmatchedPath} 확인 필요.`);
  }

  return { csvPath, xlsxPath, unmatchedPath, unmatchedCount, studentCount: rows.length };
}

module.exports = { runScoring, NoRawDataError };

if (require.main === module) {
  runScoring().catch((e) => {
    console.error('[score] 실패:', e.stack || e.message);
    process.exit(1);
  });
}
