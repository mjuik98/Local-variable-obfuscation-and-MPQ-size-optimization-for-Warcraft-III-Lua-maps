# MPQ 구조 옵션

[README](../README.md)의 MPQ sector 크기 변경과 `(listfile)` 삭제를 설명한다.

### MPQ 섹터 크기 변경 (실험)

World Editor 맵은 4 KiB sector(shift 3)를 사용하며 각 sector를 독립적으로 압축한다. `compression.sectorSizeShift` 또는 `--sector-size-shift N`은 sector를 `512 × 2^N` 바이트(N = 3..8)로 바꾸고 모든 활성 블록을 다시 압축한다. LoTKT 2.4E의 축소 Lua는 4 KiB에서 1,536,074바이트, 64 KiB에서 991,000바이트였고, 맵 전체 zlib 9 추정치는 61.2 MB에서 53.2 MB였다.

모든 활성 블록을 디코딩할 수 있어야 한다. 이름은 `(listfile)`과 알려진 내부 파일에서 찾으며, 암호화 블록은 정확히 하나의 알려진 이름이 필요하다. FIX_KEY 블록은 새 offset으로 다시 암호화한다. 해시·locale 슬롯, 블록 번호, 원본 크기, 암호화 플래그와 attributes 내용을 유지하고 압축 비트·offset·packed 크기만 바뀐다. PKWARE·single-unit·sector CRC 등 지원하지 않는 블록이 있으면 중단한다. 재압축 제외 목록과 함께 사용할 수 없고 재압축을 켜야 한다.

도구의 정적 검사는 MPQ 재읽기만 증명한다. 2026-10-07에 사용자가 LoTKT 2.4E의 64 KiB sector 사본(`maximum`·전체 정리 포함)을 배틀넷 솔로 플레이로 로딩·플레이했고 이상이 없었다([검증 기록](verification.md)). 멀티플레이와 다른 shift 값은 확인하지 않았다. `maximum` 프리셋은 64 KiB(shift 7)를 사용하며, 문제가 있으면 `--keep-sector-size`로 되돌린다.

### `(listfile)` 삭제 (실험)

`cleanup.listfile` 또는 `--remove-listfile`은 sector 변경까지 모든 단계가 끝난 뒤 MPQ `(listfile)`을 삭제한다. Warcraft III는 파일을 이름의 해시로 찾으므로 실행에 listfile이 필요하지 않다. MPQ 도구가 파일 목록을 바로 보여 주지 못하고 World Editor로 저장할 때 import 파일이 빠지기 쉬워진다. 알려진 이름 목록으로 대입하면 다시 찾을 수 있어 완전한 숨김은 아니다. 삭제 뒤에도 모든 필수 파일을 이름으로 다시 읽어 검증하며, 결과 맵의 파일별 절감 표는 이름 대신 블록 번호로 표시될 수 있다. `maximum` 프리셋에서 켜진다.

### 병렬 섹터 압축의 메모리와 대기

재압축할 sector가 합계 512 KiB 이상이거나 Zopfli를 켜면 `CPU 논리 코어 수 - 1`개(최대 12개)의 worker로 sector를 나눠 압축한다. 결과 바이트는 단일 스레드와 같다. 아래 두 동작은 측정·검토 뒤 현재 구조를 유지하기로 정한 것이다.

**메모리.** 60 MB 합성 맵의 기본 보호에서 최대 메모리는 worker가 없을 때 316 MB, worker 3개일 때 553 MB였다(2026-10-07, `59c2b07`에서 worker 결과를 정확한 크기로 전달해 약 2.6 GB에서 줄인 뒤). 차이의 대부분은 대기 중인 worker 3개 자체(약 43 MB), 모든 입력 sector를 담는 공유 버퍼(입력 크기와 같음, 약 60 MB), 작업 중 각 worker가 쓰는 메모리다. 공유 버퍼를 8 MiB 단위로 나눠 처리해 보았지만 최대 메모리가 약 4%(553 → 약 529 MB)만 줄어 적용하지 않았다.

**worker가 작업 중 비정상 종료될 때.** 압축 호출은 동기 API라서 메인 스레드는 결과를 기다리는 동안 이벤트 루프를 돌리지 않는다. Node에서 worker 종료는 `exit` 이벤트와 `threadId = -1`로만 알 수 있는데, 둘 다 이벤트 루프가 돌아야 갱신되므로 기다리는 중에는 확인할 수 없다. 처리 시간만으로 판단하는 방법도 Zopfli처럼 sector 하나에 오래 걸리는 정상 작업과 구분할 수 없다. 그래서 worker가 작업 도중 메모리 부족 등으로 종료되면 최대 10분 동안 진행이 없는지 기다린 뒤 `Sector compression made no progress` 오류로 중단한다. 결과를 추측하거나 빈 결과로 이어가지는 않는다. worker 안에서 발생한 일반 오류는 `Sector compression failed: …`로 즉시 전달된다. worker를 시작하지 못하던 경우(부모의 `--input-type` 옵션 상속)는 `execArgv: []`로 해결했다.
