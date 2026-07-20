const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const parser = require('./parser');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-test-'));
}

function writeNdjson(filePath, lines) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

test('listDateDirs: YYYY-MM-DD 형식 디렉터리만 골라낸다', () => {
  const dir = makeTmpDir();
  try {
    const bandDir = path.join(dir, '111');
    fs.mkdirSync(path.join(bandDir, '2026-06-28'), { recursive: true });
    fs.mkdirSync(path.join(bandDir, '2026-06-29'), { recursive: true });
    fs.mkdirSync(path.join(bandDir, '_members'), { recursive: true });
    fs.writeFileSync(path.join(bandDir, 'collection_status.json'), '{}');
    const dirs = parser.listDateDirs(bandDir).sort();
    assert.deepEqual(dirs, ['2026-06-28', '2026-06-29']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listDateDirs: 밴드 디렉터리가 없으면 빈 배열', () => {
  const dir = makeTmpDir();
  try {
    assert.deepEqual(parser.listDateDirs(path.join(dir, 'nope')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseBandRaw: post/comment를 posts 맵과 activities 목록으로 변환한다', () => {
  const dir = makeTmpDir();
  try {
    const bandId = '111';
    const postCreatedAt = Date.UTC(2026, 5, 28, 1, 0, 0);
    const commentCreatedAt = Date.UTC(2026, 5, 28, 2, 0, 0);
    writeNdjson(path.join(dir, bandId, '2026-06-28', 'items.ndjson'), [
      {
        schemaType: 'post',
        data: {
          post_no: 1,
          author: { user_no: 1001, name: '홍길동' },
          created_at: postCreatedAt,
          content: '오늘의 게시글입니다',
        },
      },
      {
        schemaType: 'comment',
        parentCommentId: null,
        data: {
          post_no: 1,
          comment_id: 'c1',
          author: { user_no: 1002, name: '김철수' },
          created_at: commentCreatedAt,
          body: '좋은 글이네요',
        },
      },
    ]);

    const { posts, activities } = parser.parseBandRaw(dir, bandId);

    assert.equal(posts.size, 1);
    assert.equal(posts.get('1').content, '오늘의 게시글입니다');

    assert.equal(activities.length, 2);
    const comment = activities.find((a) => a.kind === 'comment');
    const post = activities.find((a) => a.kind === 'post');

    assert.deepEqual(comment, {
      bandId: '111',
      userNo: 1002,
      authorName: '김철수',
      createdAtMs: commentCreatedAt,
      kind: 'comment',
      postNo: '1',
      commentId: 'c1',
      parentCommentId: null,
      textPreview: '좋은 글이네요',
    });
    assert.deepEqual(post, {
      bandId: '111',
      userNo: 1001,
      authorName: '홍길동',
      createdAtMs: postCreatedAt,
      kind: 'post',
      postNo: '1',
      commentId: null,
      parentCommentId: null,
      textPreview: '오늘의 게시글입니다',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseBandRaw: 작성자가 없는(user_no null) 댓글/게시글은 활동에서 제외된다', () => {
  const dir = makeTmpDir();
  try {
    const bandId = '111';
    writeNdjson(path.join(dir, bandId, '2026-06-28', 'items.ndjson'), [
      { schemaType: 'post', data: { post_no: 2, author: null, created_at: 1, content: '탈퇴회원 글' } },
      {
        schemaType: 'comment',
        data: { post_no: 2, comment_id: 'c2', author: { user_no: null }, created_at: 2, body: 'x' },
      },
    ]);
    const { posts, activities } = parser.parseBandRaw(dir, bandId);
    assert.equal(posts.size, 1); // post 자체는 맵에 남는다(내용 표시/과제글 판정용)
    assert.equal(activities.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseBandRaw: 손상된(JSON.parse 실패) 라인은 건너뛴다', () => {
  const dir = makeTmpDir();
  try {
    const bandId = '111';
    const filePath = path.join(dir, bandId, '2026-06-28', 'items.ndjson');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      [
        '{not valid json',
        JSON.stringify({
          schemaType: 'post',
          data: { post_no: 3, author: { user_no: 1, name: 'a' }, created_at: 1, content: 'ok' },
        }),
      ].join('\n') + '\n',
      'utf8'
    );
    const { posts, activities } = parser.parseBandRaw(dir, bandId);
    assert.equal(posts.size, 1);
    assert.equal(activities.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseBandRaw: 여러 날짜 디렉터리를 모두 합산한다', () => {
  const dir = makeTmpDir();
  try {
    const bandId = '111';
    writeNdjson(path.join(dir, bandId, '2026-06-28', 'items.ndjson'), [
      { schemaType: 'post', data: { post_no: 1, author: { user_no: 1, name: 'a' }, created_at: 1, content: 'd1' } },
    ]);
    writeNdjson(path.join(dir, bandId, '2026-06-29', 'items.ndjson'), [
      { schemaType: 'post', data: { post_no: 2, author: { user_no: 2, name: 'b' }, created_at: 2, content: 'd2' } },
    ]);
    const { posts, activities } = parser.parseBandRaw(dir, bandId);
    assert.equal(posts.size, 2);
    assert.equal(activities.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseBandRaw: raw 디렉터리 자체가 없으면 빈 결과를 반환한다', () => {
  const dir = makeTmpDir();
  try {
    const { posts, activities } = parser.parseBandRaw(dir, '999');
    assert.equal(posts.size, 0);
    assert.equal(activities.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadLatestMemberSnapshot: _members 디렉터리가 없으면 null', () => {
  const dir = makeTmpDir();
  try {
    assert.equal(parser.loadLatestMemberSnapshot(dir, '111'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadLatestMemberSnapshot: 파일명(타임스탬프) 기준 가장 마지막 스냅샷을 읽는다', () => {
  const dir = makeTmpDir();
  try {
    const membersDir = path.join(dir, '111', '_members');
    fs.mkdirSync(membersDir, { recursive: true });
    fs.writeFileSync(
      path.join(membersDir, 'members_1700000000000.json'),
      JSON.stringify({ members: [{ user_no: 1, name: 'old', role: 'member' }] })
    );
    fs.writeFileSync(
      path.join(membersDir, 'members_1700000000001.json'),
      JSON.stringify({ members: [{ user_no: 2, name: 'new', role: 'member' }] })
    );
    const snapshot = parser.loadLatestMemberSnapshot(dir, '111');
    assert.deepEqual(snapshot.members, [{ user_no: 2, name: 'new', role: 'member' }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
