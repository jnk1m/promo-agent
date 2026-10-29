# 평가용 자료 봉인

만든 날짜: 2026-10-29

| 파일 | sha256 |
|---|---|
| eval/worlds.json | 22458cbbe3ef8459257d7f8b0600d6e55ab5898c753e5ccec71579eba3d4faac |
| eval/reason-sentences.json | 1a22e4f926756c64ce21d960ae264de7e1c05c3a0558d1e7acae71c7d0975a5b |

확인: `shasum -a 256 eval/worlds.json eval/reason-sentences.json`, 형식과 값 검사는 `python3 -I eval/check.py`.

이 파일들은 추정기 개발과 다른 세션이 썼고 추정기 수정 뒤 바꾸지 않는다. 같은 모델 계열(Claude)이 쓴 문장이라 해석기에 유리할 수 있다는 한계가 있다.
