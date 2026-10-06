# 파일 정리와 검토 계약

[README](../README.md)의 파일 정리 옵션과 검토 계약을 설명한다.

### 파일 정리

**기본값은 파일 정리 비활성화다.** LoTKT에는 동적 `Preloader`와 전역 조회가 있어 파일 이름 검색만으로 실행 의존성을 확정할 수 없다. 기본 실행은 모든 에디터·개발·리소스 파일을 보존한다.

고급 설정에서 **에디터 파일 정리·개발 파일 정리**를 켠 경우도 같은 검사를 적용한다. `Preloader` 오류는 실행 파일 사용 여부를 확인하지 못해 삭제를 중단했다는 뜻이다. 정리하려면 메인 **작업** 화면의 **검토 계약 → 찾아보기**에서 현재 입력 맵을 검토한 JSON을 선택한 뒤 검사한다. 일치하는 계약이 없으면 두 정리 옵션을 해제한다. Lua 보호·문자열 숨김·재압축은 정리를 끈 상태에서도 사용할 수 있다. 프리셋을 바꾸거나 검사 버튼만 다시 눌러 이 조건을 우회하지 않는다.

정리는 위의 명시 옵션 또는 JSON 설정으로 켠다. 대상은 에디터 트리거 데이터 두 파일, `lotkt-object-history.json`, `lotkt-object-receipt.json`, 그리고 별도 옵션인 에디터 데이터(`war3map.w3r` 영역, `war3map.w3c` 카메라, `war3map.w3s` 사운드, `war3map.imp` import 목록)뿐이다. Lua 맵은 editor `main`이 `CreateRegions`·`CreateCameras`·`InitSounds`로 같은 데이터를 스크립트에서 만들고, import 파일은 MPQ 경로로 읽힌다. 에디터 데이터를 지우면 World Editor에서 해당 정보가 사라지므로 편집용 원본을 유지하고, 영역 이벤트·카메라·사운드·import 리소스를 게임에서 확인한다. `war3map.imp`를 지우면 행 단위 import 갱신은 하지 않는다. 모델·텍스처·오브젝트·스킨·일반 import나 이름 미확인 파일을 미사용으로 추측해 삭제하지 않는다.

정리 후보의 문자열 참조는 Lua escape와 상수 문자열 연결까지 확인한다. 파일 로더, `debug/package`, 확인할 수 없는 `_G/_ENV` 접근 또는 환경 테이블 별칭이 있으면 정리를 거부한다. 이 경우 `--no-cleanup` 또는 필요한 후보의 `--keep-file`로 보존한다.

동적 저장 기능과 native 조회가 있는 LoTKT 입력에는 별도 의존성 검토가 필요하다. `cleanup/lotkt-contract.json`은 현재 검토한 기존 빌드 산출물 하나에만 적용하는 계약이다. 맵 전체와 원본 Lua의 SHA-256, 동적 파일 접근·오브젝트·import 검토 근거, 각 삭제 후보의 이유와 한계를 포함한다. 파일 이름 검색만으로 정리를 허용하지 않으며 계약은 도구가 생성한 안전성 증명이 아니다.

계약은 파일명이나 버전명이 같은 다른 맵에 재사용할 수 없다. 새 빌드와 이미 보호한 사본은 원본 맵·Lua 해시가 달라질 수 있다. Windows 패키지의 `cleanup` 폴더에도 검토 계약을 포함하지만, 현재 입력과 정확히 일치하는 계약을 직접 선택해야 한다. 이전 계약을 선택하면 불일치 오류로 중단한다.

2026-10-06에 검토한 `LoTKT/dist/LoTKT 2.4E.w3x`에는 `cleanup/lotkt-2.4e-2026-10-06-contract.json`을 사용한다. 검토본의 맵 SHA-256은 `7fb4bd96153b66560160d534bae4e9a9cd90e63aff464ab3c18d59de89612e63`이다. 저장 파일·native 조회와 모든 활성 파일, 오브젝트·스킨·import·모델을 실제 입력 기준으로 검토했다. receipt의 원본 sourceHash에 해당하는 맵은 식별하지 못했으며 provenance 검증을 했다고 주장하지 않는다. 외부 저장 파일은 기존 FileIO 형식으로 가정하고, 외부 주입 스크립트·애드온과 실제 게임 검증은 범위 밖이다. 이후 다시 빌드한 2.4E에는 이 계약도 일치하지 않을 수 있다.

같은 입력의 에디터 데이터까지 정리하려면 `cleanup/lotkt-2.4e-2026-10-06-editor-data-contract.json`을 사용한다. 기존 검토에 더해 editor `main`(412..428행)의 `InitSounds`·`CreateRegions`·`CreateCameras` 호출, 영역 88개·카메라 1개·사운드 7개가 Lua의 `gg_rct_`·`gg_cam_`·`gg_snd_` 개수와 일치함, import 목록 873행이 모두 MPQ에 남아 있음과 네 파일 이름의 참조 부재를 기록했다. 게임 실행으로 확인한 것은 아니다.

```powershell
npm run protect -- "..\LoTKT\dist\LoTKT 2.4E.w3x" --check --preset maximum --clean-editor --clean-development --clean-editor-data --cleanup-contract "cleanup/lotkt-2.4e-2026-10-06-editor-data-contract.json" --sector-size-shift 7
```

Windows에서는 위 계약을 **검토 계약 → 찾아보기**로 선택하고, 고급 설정에서 정리 두 항목을 켠 뒤 검사한다. 문자열 보호도 적용하려면 **보호 강화** 프리셋을 선택한다. 계약 자체가 정리나 문자열 보호를 켜지는 않는다.

계약은 정리를 자동으로 켜거나 삭제 대상을 늘리지 않는다. 검토된 `Preloader`와 동적 환경 조회만 예외로 허용한다. 외부 Lua loader·`io/debug/package`의 직접·상수 키 접근과 후보의 명시적 문자열 참조는 계속 거부한다. 실제 선택한 후보는 모두 계약에 있어야 하며 `--keep-file`이 우선한다. 입력이 바뀌면 계약도 실패하므로 근거를 다시 검토해야 한다. 임의로 해시만 갱신하지 않는다.

기존 계약의 검토를 재사용할 수 있는지 Windows의 **계약 재검토** 탭이나 아래 CLI로 비교할 수 있다. 이전 계약이 이전 맵에 정확히 일치해야 한다. Lua·오브젝트·스킨·import·리소스를 포함한 모든 활성 파일과 MPQ의 locale·alias·미열거 상태를 비교한다. 확인 가능한 파일은 디코딩한 내용, opaque·이름 미확인 블록은 packed bytes와 메타데이터를 엄격히 비교한다. 내용이 달라지거나 동일성을 확정할 수 없으면 변경 목록과 재검토 이유를 반환하며 갱신 후보를 만들지 않는다. 손상·미지원 맵은 명시적으로 중단한다.

전체 의존성은 같고 MPQ 재포장만 달라진 경우에만 기존 근거를 유지한 계약 후보를 제안한다. 비교는 계약을 자동으로 저장하거나 승인하지 않는다. 후보 저장 버튼이나 `--contract-output`을 명시하면 비교를 다시 수행하고 새 JSON에만 저장한다. v1 계약의 정확한 맵·Lua 해시 검증은 계속 유지된다.

```powershell
npm run protect -- "C:\Maps\New.w3x" --review-cleanup --previous-input "C:\Maps\Reviewed.w3x" --cleanup-contract "C:\Maps\Reviewed.json"
# 재포장 동일성이 확인된 후보를 명시적으로 저장할 때만 추가한다.
npm run protect -- "C:\Maps\New.w3x" --review-cleanup --previous-input "C:\Maps\Reviewed.w3x" --cleanup-contract "C:\Maps\Reviewed.json" --contract-output "C:\Maps\New-contract.json"
```

계약에 기록한 SHA-256과 정확히 일치하는 검토본에 모든 옵션을 적용하는 메모리 검사는 다음과 같다. LoTKT를 새로 빌드하면 같은 경로의 맵이라도 기존 계약이 일치하지 않을 수 있으며 재검토가 필요하다.

```powershell
npm run protect -- "C:\Maps\Reviewed.w3x" --check --hide-strings --clean-editor --clean-development --cleanup-contract "cleanup/lotkt-contract.json"
```

삭제한 파일에 대응하는 `war3map.imp` 행과 MPQ `(listfile)` 항목도 정리한다. 지원하지 않는 import 형식이나 손상 데이터는 중단한다. 특정 파일 보존·재압축 제외 설정은 Warcraft III MPQ 이름 규칙처럼 ASCII 영문자의 대소문자와 `/`·`\` 차이만 무시한다. 한글 등 UTF-8 경로도 지정할 수 있다.
