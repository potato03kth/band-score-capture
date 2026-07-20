const DATA_HOSTS = ['api-kr.band.us', 'bapi-kr.band.us'];

// 정찰(doc/recon-findings.md §1) 관측 URL 패턴. 세그먼트 경계(? 또는 문자열 끝)까지 매칭해
// get_post 가 get_posts_and_announcements 에 잘못 매칭되지 않도록 한다.
const PATTERNS = {
  feedList: /\/get_posts_and_announcements(?:[/?]|$)/,
  postDetail: /\/get_post(?:[/?]|$)/,
  announcementDetail: /\/get_announcement(?:[/?]|$)/,
  commentList: /\/get_comments(?:[/?]|$)/,
  memberList: /\/get_members_of_band(?:[/?]|$)/,
};

function isDataHost(urlString) {
  try {
    const u = new URL(urlString);
    return DATA_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

function classifyUrl(urlString) {
  if (!isDataHost(urlString)) return null;
  for (const key of Object.keys(PATTERNS)) {
    if (PATTERNS[key].test(urlString)) return key;
  }
  return null;
}

// content_key는 JSON 문자열을 URL 인코딩한 파라미터: {"content_type":"post","post_no":43}
// 또는 대댓글 조회 시 {"content_type":"comment","comment_id":N} (M1에서 실캡처로 확정, recon-findings §1).
function parseContentKey(urlString) {
  try {
    const u = new URL(urlString);
    const raw = u.searchParams.get('content_key');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseQueryParams(urlString) {
  try {
    const u = new URL(urlString);
    const out = {};
    for (const [k, v] of u.searchParams.entries()) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

module.exports = {
  DATA_HOSTS,
  PATTERNS,
  isDataHost,
  classifyUrl,
  parseContentKey,
  parseQueryParams,
};
