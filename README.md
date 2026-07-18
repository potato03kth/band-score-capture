# band-score-capture
get query data from Naver band, auto-scoring based on student's activity

## M1: 취득(acquire) 실행

설계 문서는 [doc/PLAN.md](doc/PLAN.md), 정찰 기록은 [doc/recon-findings.md](doc/recon-findings.md) 참고.

```
npm install
npm start
```

1. 최초 실행 시 `input/1_설정.xlsx`가 없으면 자동 생성되고 프로그램이 종료됩니다.
   엑셀의 노란 칸(측정 시작일·종료일·총점 상한·실행 모드, 대상 밴드 목록)을 채우고 저장한 뒤 다시 실행하세요.
2. 창이 뜨면 **사람이 직접** 밴드 로그인(2FA 포함)을 완료합니다. 자동 로그인은 없습니다.
3. 로그인 후 밴드별로 피드 백필 → 게시글별 댓글·대댓글 수집 → 멤버 목록 수집이 저속으로 순차 진행됩니다.
4. 원천 데이터는 `data/raw/<bandId>/`, 감사 로그는 `logs/audit/`에 append-only로 쌓입니다.
   `data/raw/<bandId>/collection_status.json`에서 밴드별 수집 완전성(피드/댓글/대댓글 소진 여부)을 확인할 수 있습니다.

채점(score/) 모듈은 아직 없습니다(M2 예정).
