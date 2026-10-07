# WarcraftLuaProtector

Warcraft III Lua 맵의 이름을 난독화하고 배포 용량을 줄이는 로컬 도구다. LoTKT에서 빌드를 완료한 맵을 입력으로 사용하며, LoTKT 소스나 빌드 도구를 수정하지 않는다.

## 현재 구현

버전 0.7.0은 CLI와 Windows 파일 선택 화면을 제공한다. 모든 처리는 로컬에서 수행한다.

- Lua 5.3 문법과 lexical scope를 분석해 local 변수·함수·매개변수 이름을 결정적으로 변경한다. 참조가 많은 바인딩에 짧은 이름을 우선 배정하고, 캡처와 이름 가림이 충돌하지 않는 스코프에서 이름을 재사용한다.
- 토큰 단위로 주석과 불필요한 공백을 제거한다. 기본값에서는 전역/native/public 이름, `main/config`, `gg_*`·`udg_*`, 메서드 필드를 보존한다. 문자열 표기는 별도 옵션을 켠 경우에만 변경한다.
- 실험 옵션으로 정적 조회만 확인된 스크립트 정의 전역, 외부로 전달되지 않는 닫힌 테이블의 필드 이름을 변경하고, 엔진·Lua 라이브러리 함수 호출을 하나의 local 테이블 조회로 숨긴다. 리터럴 rawcode의 `FourCC` 호출은 같은 정수로 바꿀 수 있다. 동적 전역 조회를 확인할 수 없으면 거부한다. 자세한 규칙은 [전역·필드 이름 변경과 엔진 함수 숨김](docs/protection.md#전역필드-이름-변경과-엔진-함수-숨김-실험) 문서에 있다.
- 변환 뒤 Lua를 재파싱하고, local 이름 외의 구문 구조와 변수 바인딩이 같은지 확인한다.
- 선택한 문자열 리터럴을 숫자 바이트 이스케이프로 숨긴다. 복원 함수·추가 호출 없이 Lua가 원래 바이트를 읽으며, 변환 뒤 모든 문자열의 바이트와 구문 구조를 확인한다.
- 선택한 seed로 짧은 local 이름의 배정을 다양화하는 `seeded` 모드를 제공한다. 기존 `compact` 모드와 기본 출력은 유지한다.
- 실험적인 `runtime` 문자열 모드는 ChaCha20 암호문을 4바이트 단위 숫자로 저장하고 순수 Lua로 복원한다. 원래 바이트를 처음 사용 시 복원해 내부 캐시에 보관하고 해당 암호문 테이블을 해제한다. 게임 난수·native·표준 라이브러리 호출에 의존하지 않는다. 복원 함수와 VM 해석기는 청크에서 쓰지 않는 가장 짧은 이름을 사용해 고정된 도구 식별 이름을 남기지 않는다.
- 명시적으로 지정한 local 함수에 제한된 전용 VM을 적용한다. 원본 함수의 수치·논리식과 조건 분기를 seed별 명령 데이터로 바꾸며, 지정하지 않은 코드의 구문 보존과 출력 재파싱을 검사한다.
- 지원 파일은 zlib 레벨·전략과 비압축 후보를 비교하고, 기존 payload보다 작아지는 경우에만 재압축한다. 기본은 이전과 같은 레벨 6·9와 `default` 전략이다. MPQ 빈 공간도 회수한다.
- 각 단계에서 MPQ를 재읽고, 변경하지 않은 파일의 packed payload·메타데이터·locale과 미열거 활성 블록을 검증한다. FIX_KEY 암호화 파일은 원래 offset을 유지한다.
- 실험 옵션으로 MPQ sector 크기를 바꿔 모든 활성 블록을 다시 압축한다. 내용·해시/locale 슬롯·블록 번호·크기·암호화를 유지하고 전체를 다시 읽어 확인한다. [MPQ 섹터 크기 변경](docs/archive.md#mpq-섹터-크기-변경-실험) 문서를 참고한다.
- MPQ 헤더는 Storm과 같이 512바이트 정렬 위치에서만 찾고, sector shift·hash table 크기와 디코딩한 파일 길이가 맞지 않으면 중단한다.
- 설정으로 local 이름 보존, 파일 정리 후보 보존, 재압축 제외와 각 변환의 비활성화를 지원한다.
- 대형 Lua의 원본·VM·이름 변환 출력 AST와 스코프 분석을 재사용하고, local/upvalue 한계 검사는 필요한 바인딩 정보만 계산한다. 구문 검증은 AST를 직접 비교하고 문자열 대상은 한 번에 수집한다. 이름 수정은 한 번의 문자열 조립으로 처리하며 입력·출력 파일 검증은 제한된 크기의 버퍼를 사용한다.
- MPQ 파일 조회는 두 경로 해시의 색인을 재사용하며 모든 locale·alias 슬롯을 보존한다. 변경한 Lua·import에 이미 시험한 압축 후보를 반복하지 않고, 원문이 같은 파일은 기존 압축이 최선인지 계속 확인한다.
- 변환 거부 오류에는 감지한 최초 원인과 소스 위치, 필요한 보존 옵션을 표시한다.
- 여섯 가지 프리셋, 기존 정리 계약의 재검토 지원, Windows의 검사·별도 출력·취소 화면을 제공한다.
- 고급 설정 화면과 최종 적용 설정 확인, 파일별 실제 압축 크기·절감률과 단계별 절감 내역을 제공한다.
- 현재 설정과 기본 프리셋의 문자열 숨김 켬·끔 조합을 순차적으로 메모리에서 비교한다. 성공한 조합을 선택해 다음 작업에 적용할 수 있다.
- Windows 화면을 열어 둔 동안 검증한 맵 한 건을 메모리에 보관하고, 같은 입력·최종 설정·설정 파일·계약에 한해 재사용한다. 입력과 결과 버퍼의 합은 192 MiB로 제한한다.
- 입력은 읽기 전용이다. 결과를 검증한 뒤 새로운 출력 경로에만 확정하며 기존 파일은 덮어쓰지 않는다.

보호 기능은 소스 분석 비용을 높인다. 런타임 문자열 복원과 VM에도 실행에 필요한 데이터·해석기가 포함되며 암호학적인 비밀 보관, 에디터 열기 방지나 복구 불가능성을 보장하지 않는다. 용량 최적화는 실행 속도 개선을 뜻하지 않으며, 모든 입력에서 전체 맵 크기가 줄어드는 것도 보장하지 않는다.

## 사용

Windows 배포 폴더의 `WarcraftLuaProtector.exe`를 실행하면 파일 선택 화면이 열린다. 폴더 전체를 함께 이동해야 하며, 포함된 Node.js 런타임을 사용하므로 별도로 Node.js를 설치할 필요가 없다. Windows의 .NET Framework와 Windows Forms를 사용한다.

화면에서 입력 맵과 프리셋을 선택하고 **검사**를 누르면 결과를 메모리에서 검증한다. **배포 사본 저장**은 사용자가 지정한 새로운 경로에만 맵을 쓴다. 문자열 숨김 체크박스는 설정 파일의 문자열 선택보다 우선한다. 계산은 별도 worker에서 실행하며, 취소는 계산을 중단하거나 쓰기 중 임시 파일을 정리한다. 최종 파일 확정에 들어간 경우에는 완료 결과를 기다린다. 검사 완료는 게임 실행 검증을 뜻하지 않는다.

**고급 설정**에서 Lua 변환·파일 정리·재압축, 압축 레벨·전략과 보존·제외 목록을 편집한다. 목록은 설정 JSON의 기존 목록에 추가되며, 문자열 값은 공백과 빈 문자열도 그대로 보존한다. JSON의 기존 목록을 바꾸려면 해당 JSON을 수정하거나 설정 경로를 비운다. **고급 설정 해제**는 화면에서 추가한 설정을 해제한다. **적용 설정 확인**은 프리셋 → JSON → 고급 설정 → 화면 문자열 선택을 모두 적용한 값을 보여 주며 맵을 열거나 쓰지 않는다.

검사 결과의 **파일별 절감** 탭은 실제 MPQ packed 크기를 블록마다 한 번 집계한다. alias는 한 행에 이름을 함께 표시하고 locale별 다른 블록은 별도 행에 표시한다. 이름을 알 수 없는 활성 블록은 번호로 표시한다. 절감량이 음수이면 용량이 늘었다는 뜻이다. 파일 데이터 외 공간에는 prefix·헤더·테이블·빈 공간 등이 포함되므로 그 전체를 빈 공간이라고 해석하지 않는다. 전체 절감량은 파일별 절감 합계와 기타 공간 변화가 일치하는지 검증한다.

**설정 조합 비교**는 현재 사용자 설정의 문자열 숨김 켬·끔과 `size/protect/distribution` 기본 설정의 켬·끔을 평가한다. 현재 설정 두 조합에만 JSON·고급 설정이 적용되고, 기본 프리셋 조합은 보존·제외 목록을 포함한 기본값을 사용한다. 동일한 조합은 중복 계산하지 않는다. 입력과 계약은 모든 조합에서 다시 검증하며, 적용할 수 없는 조합은 행별 원인을 표시한다. 성공한 행의 **선택한 조합 적용**은 JSON 경로를 비우고 그 최종 설정을 고급 설정으로 옮긴다. 비교·선택만으로 맵을 저장하지 않는다. 비교 시간은 이 도구의 처리 시간이며 게임 로딩·FPS 측정이 아니다.

검사 뒤 저장할 때 입력·최종 설정·설정 JSON·계약이 그대로이면 재파싱과 재압축을 반복하지 않고 검증한 결과를 재사용한다. 파일 내용은 다시 읽어 확인하고 저장 직전에도 입력·설정·계약을 확인한다. 다음 검사에서 설정 변경이 확인되거나 취소, 비교·계약 재검토, 프로그램 종료가 발생하면 이전 보관 결과를 해제하거나 교체한다. 설정 미리보기만으로는 보관 결과를 해제하지 않는다. 192 MiB를 넘는 입력·결과 조합은 보관하지 않고 정상 처리하며, 다음 작업에서 다시 검사한다. 이 상한은 보관 버퍼에 적용되며 변환 작업 전체의 메모리 상한을 뜻하지 않는다. 디스크 캐시와 임시 보호 맵은 만들지 않는다.

개발 환경에서 Windows 실행 패키지를 만들려면 다음 명령을 사용한다. Windows x64와 Node.js가 필요하며, 같은 버전의 기존 패키지는 덮어쓰지 않는다. 이 명령은 도구 배포 폴더만 만들고 보호 맵을 생성하지 않는다. Node.js 라이선스는 사용한 런타임 버전의 공식 저장소에서 받아 포함한다.

```powershell
npm run package:windows
# 같은 버전을 다른 새 배포 폴더에 빌드할 때
npm run package:windows -- --output "dist/WarcraftLuaProtector-0.7.0-win-x64-final"
```

CLI는 Node.js 22 이상이 필요하다. 저장소 폴더에서 실행한다.

```powershell
npm ci
npm run protect -- "..\LoTKT\dist\LoTKT_Lua-built.w3x" --check
```

`--check`는 전체 변환과 검증을 메모리에서 수행하며 맵 파일을 쓰지 않는다. 위 예시는 이미 존재하는 빌드 산출물을 검사하며 LoTKT를 새로 빌드하지 않는다.

별도 배포 사본을 만들 때는 기존 파일이 없는 명시적인 경로를 지정한다. 입력과 같은 확장자를 사용하며 출력 폴더는 미리 존재해야 한다.

```powershell
npm run protect -- "C:\Maps\MyMap.w3x" --output "C:\Maps\MyMap-protected.w3x"
```

파일 시스템이 같은 볼륨의 hard link 생성을 지원해야 출력을 확정할 수 있다. 지원하지 않으면 중단하고 임시 파일을 제거한다. 입력 파일이 처리 중 변경돼도 출력을 중단한다.

옵션은 `npm run protect -- --help`로 확인한다.

| 옵션 | 동작 |
| --- | --- |
| `--check` | 파일 출력 없이 변환·검증 |
| `--config settings.json` | 엄격한 JSON 설정 읽기 |
| `--preset ID` | `fast-check`, `size`, `protect`, `distribution`, `hardened`, `maximum` 중 선택 |
| `--show-settings` | 맵 입력 없이 최종 적용 설정 표시 |
| `--compare` | 프리셋·문자열 조합을 메모리에서 비교; 출력 맵 없음 |
| `--details` | 검사·저장 결과의 실제 packed 파일 절감 내역 표시 |
| `--compression-strategy ID` | 압축 전략 후보 지정; 반복 가능, JSON 전략 목록보다 우선 |
| `--no-minify` / `--no-rename` | 공백·주석 제거 / local 이름 변경 해제 |
| `--rename-globals` / `--no-rename-globals` | 정적 조회만 확인된 스크립트 정의 전역 이름 변경 켜기 / 끄기 (실험) |
| `--rename-fields` / `--no-rename-fields` | 닫힌 테이블 필드 이름 변경 켜기 / 끄기 (실험) |
| `--keep-global Name` | 해당 전역 이름 보존; 반복 지정 가능 |
| `--hide-natives` / `--no-hide-natives` | 엔진·Lua 라이브러리 함수 호출을 local 테이블 조회로 숨기기 켜기 / 끄기 (실험) |
| `--fold-fourcc` / `--no-fold-fourcc` | 리터럴 rawcode의 `FourCC` 호출을 같은 정수로 바꾸기 켜기 / 끄기 (실험) |
| `--name-mode ID` | `compact` 또는 seed별 이름을 배정하는 `seeded` |
| `--seed Value` | 이름·런타임 문자열·VM의 결정적 변환 seed |
| `--hide-strings` / `--no-hide-strings` | 문자열 숨김 켜기 / 설정 파일에서 켠 문자열 숨김 해제 |
| `--string-mode ID` | `escape` 또는 `runtime`; 모드 선택만으로 숨김을 켜지는 않음 |
| `--no-runtime-strings` | 문자열 방식을 `escape`로 바꿈; 활성 여부는 유지 |
| `--vm-function Name` | 검토한 원본 local 함수 이름을 VM 대상으로 추가; 반복 가능 |
| `--no-vm` | JSON과 CLI에서 선택한 VM 함수 전체 해제 |
| `--keep-string Value` | 디코딩한 문자열 값 보존; 반복 지정 가능 |
| `--clean-editor` | 참조 검사 후 `war3map.wtg`, `war3map.wct` 정리 |
| `--clean-development` | 참조 검사 후 LoTKT 개발 메타데이터 두 파일 정리 |
| `--clean-editor-data` | 참조 검사 후 `war3map.w3r/w3c/w3s`와 `war3map.imp` 정리 |
| `--remove-listfile` / `--keep-listfile` | 모든 단계가 끝난 뒤 MPQ `(listfile)` 삭제 / 보존 (실험) |
| `--cleanup-contract File.json` | 정확히 일치하는 입력 맵의 의존성 검토 계약 읽기 |
| `--review-cleanup` | 이전 계약과 두 입력 맵을 비교; 맵 출력 없음 |
| `--previous-input Map.w3x` | 이전 계약에 정확히 일치하는 검토 원본 |
| `--contract-output New.json` | 재포장 동일성이 확인된 계약 후보를 새 파일로 명시적 저장 |
| `--no-cleanup` | 설정 파일에서 켠 정리도 모두 해제 |
| `--no-compress` | 재압축 최적화 해제; MPQ 빈 공간 회수는 유지 |
| `--sector-size-shift N` | MPQ sector를 `512 × 2^N` 바이트(N = 3..8)로 바꾸고 전체 재압축 (실험) |
| `--keep-sector-size` | 설정 파일에서 지정한 sector 크기 변경 해제 |
| `--zopfli` / `--no-zopfli` | 압축이 잘 되는 sector에 Zopfli zlib 후보 추가 켜기 / 끄기 (느림) |
| `--keep-local Name` | 해당 local 이름의 모든 바인딩 보존; 반복 지정 가능 |
| `--keep-file Path` | 정리 후보 보존; 반복 지정 가능 |
| `--exclude-compress Path` | 해당 파일의 추가 재압축 제외; 반복 지정 가능 |

재압축 제외는 내용 보존 파일의 추가 최적화에 적용한다. 변환된 Lua나 수정된 import manifest를 MPQ에 다시 기록하는 과정은 그대로 수행한다.

## 프리셋

| ID | 화면 이름 | 기본 동작 |
| --- | --- | --- |
| `fast-check` | 빠른 검사 | Lua 원문·파일 보존, zlib 6, 메모리 검사만 허용 |
| `size` | 용량 최적화 | Lua 원문·파일 보존, zlib 6·9 후보 비교 |
| `protect` | 기본 보호 | local 이름·공백 최적화, 파일 보존, 문자열 숨김 끔 |
| `distribution` | 배포 준비 | 기본 보호 + 알려진 에디터·개발 파일 정리; 정리를 켜면 정확한 입력의 계약 필요 |
| `hardened` | 보호 강화 | seed 기반 local 이름 변경 + 런타임 문자열 복원; 파일 보존·VM 자동 선택 없음 |
| `maximum` | 최대 보호 | 보호 강화 + 전역·닫힌 테이블 필드 이름 변경 + 엔진·Lua 라이브러리 함수 호출 숨김(이름도 런타임 문자열로 암호화) + `FourCC` 치환 + `(listfile)` 삭제 + 64 KiB sector; 파일 정리는 별도 |

설정 우선순위는 기본값 → 프리셋 → JSON → CLI 또는 화면의 명시적 선택이다. 프리셋을 생략하면 기존 기본 동작을 사용한다. JSON 설정은 덮어쓰기 전에 엄격하게 검증하며 잘못된 값을 CLI로 가리지 않는다. 반복 보존·제외·VM 선택 옵션은 JSON 배열에 추가된다. `--no-vm`은 합친 VM 목록을 모두 비우며 다른 VM 선택보다 우선한다. `distribution --no-cleanup`은 파일 정리를 해제한다. `hardened`와 `maximum`에서만 문자열 숨김을 기본으로 켠다. 화면의 문자열 체크박스가 최종 활성 여부를 결정한다.

```powershell
npm run protect -- "C:\Maps\MyMap.w3x" --check --preset fast-check
npm run protect -- "C:\Maps\MyMap.w3x" --check --preset protect --hide-strings
npm run protect -- "C:\Maps\MyMap.w3x" --check --preset hardened --seed "release-2026-10"
npm run protect -- "C:\Maps\MyMap.w3x" --check --preset hardened --vm-function ReviewedCalculation
npm run protect -- "C:\Maps\MyMap.w3x" --check --preset maximum --seed "release-2026-10"
npm run protect -- "C:\Maps\MyMap.w3x" --check --preset maximum --keep-sector-size
npm run protect -- --show-settings --preset protect --config "settings.json"
npm run protect -- "C:\Maps\MyMap.w3x" --compare --cleanup-contract "reviewed.json"
npm run protect -- "C:\Maps\MyMap.w3x" --check --details --compression-strategy default --compression-strategy filtered
```

압축 전략은 `default`, `filtered`, `huffman-only`, `rle`, `fixed`다. 레벨과 전략의 모든 선택 조합을 기존 sector 구조 안에서 시험하고, 비압축·현재 packed 결과와 비교해 작은 것만 선택한다. 후보를 늘리면 처리 시간이 증가하며 모든 맵에서 추가 절감이 생기는 것은 아니다. locale·alias·암호화·미열거 파일의 보존 제한은 유지한다. `--no-compress`로 재압축을 끄면 추가 전략도 재압축에 사용하지 않는다.

`compression.zopfli` 또는 `--zopfli`는 zlib가 10% 이상 줄이는 sector에 한해 [Zopfli](https://github.com/google/zopfli)로 만든 zlib 스트림도 후보로 비교한다. 결과는 일반 zlib 스트림이라 게임의 압축 해제 방식은 같다. 보호한 LoTKT Lua 1 MiB 표본에서 zlib 9보다 64 KiB sector는 약 5.3%, 4 KiB sector는 약 2.8% 작았고, 처리 시간은 MiB당 각각 약 6초, 20초였다. 텍스처·오디오처럼 거의 압축되지 않는 sector는 건너뛴다. 섹터 압축은 CPU 코어 수만큼 병렬로 처리하며 결과 바이트는 단일 스레드와 같다. LoTKT 2.4E 전체에 64 KiB sector와 함께 적용하면 맵이 약 1.5 MB(2.9%) 더 작아졌지만 16 스레드 PC에서 약 10분이 걸렸다. 처리 시간이 크게 늘어나므로 기본값과 `maximum` 프리셋에서는 꺼져 있으며 최종 배포본을 만들 때 켜는 것을 권장한다.

## 상세 문서

- [Lua 보호 옵션](docs/protection.md): 문자열 숨김(escape·runtime), seed 이름, 선택적 함수 VM, 전역·닫힌 테이블 필드 이름 변경, 엔진·라이브러리 함수 숨김, `FourCC` 치환과 LoTKT 2.4E 측정 결과
- [MPQ 구조 옵션](docs/archive.md): sector 크기 변경, `(listfile)` 삭제, 병렬 섹터 압축의 메모리와 대기 동작
- [파일 정리와 검토 계약](docs/cleanup.md): 에디터·개발·에디터 데이터 정리, 검토 계약 작성·재검토와 LoTKT 계약 파일
- [게임 검증 기록과 체크리스트](docs/verification.md): 실제 Warcraft III에서 확인한 결과와 남은 확인 항목

## 설정 예시

```json
{
  "lua": {
    "minify": true,
    "renameLocals": true,
    "keepLocals": [],
    "nameMode": "compact",
    "seed": "warcraft-lua-protector",
    "vmFunctions": [],
    "renameGlobals": false,
    "renameFields": false,
    "keepGlobals": [],
    "hideNatives": false,
    "foldFourCC": false
  },
  "strings": {
    "enabled": false,
    "keep": [],
    "mode": "escape"
  },
  "cleanup": {
    "editor": false,
    "development": false,
    "editorData": false,
    "listfile": false,
    "keepFiles": []
  },
  "compression": {
    "enabled": true,
    "levels": [6, 9],
    "strategies": ["default"],
    "excludeFiles": [],
    "sectorSizeShift": null,
    "zopfli": false
  }
}
```

생략한 항목은 선택한 프리셋 또는 위 기본값을 사용한다. 알 수 없는 키나 잘못된 값은 오류로 전달한다. 같은 입력·설정과 같은 Node/zlib 환경에서 같은 결과를 만든다. 게임의 난수 호출이나 등록·실행 순서는 추가하거나 변경하지 않는다.

## 지원 범위와 제한

- 입력은 `.w3x/.w3m`, raw MPQ 또는 `HM3W` prefix가 있는 MPQ v0, 루트 `war3map.lua`를 사용하는 Lua 맵이다. MPQ 헤더는 512바이트 정렬 위치에 있어야 하고 hash table 크기는 2의 거듭제곱이어야 한다.
- `war3map.w3i` 버전 28..33 및 39의 스크립트 언어 필드를 확인한다. 맵 정보와 terrain의 전체 내용을 해석하거나 다시 쓰지는 않는다.
- 루트 Lua의 UTF-8 바이트, top-level `main/config`와 terrain의 존재를 검사한다. JASS 선택, 중복·혼합 스크립트, 미지원 맵 정보, 잘못된 UTF-8은 거부한다.
- 변경에 필요한 파일은 비압축 또는 지원 zlib 형식으로 읽을 수 있어야 한다. 읽기 미지원인 다른 파일은 opaque payload 그대로 보존하고 재압축하지 않는다. 손상된 지원 압축 데이터는 오류로 중단한다.
- 여러 locale·alias를 가진 파일은 독립 교체하지 않는다. 일반 재압축은 단일 locale·비alias·비암호화 파일로 제한한다. 미열거 파일은 추가 압축 대상으로 추측하지 않는다.
- MPQ 이름은 UTF-8 바이트로 해시하고 ASCII 영문자만 대소문자를 구분하지 않는다. `(listfile)`에서 UTF-8로 읽을 수 없는 레거시 인코딩 행은 이름을 추측하지 않아 재압축·sector 변경 대상 이름으로 쓰지 않으며, listfile을 갱신할 때도 원본 바이트를 그대로 보존한다.
- 서명, 후행 데이터, 미지원 MPQ 버전, 잘못된 범위·중첩, 미지원 attributes 구조와 검증 실패는 중단한다.
- local/upvalue 이름을 관찰하는 reflection은 이름 변경과 충돌한다. 감지된 경우 모든 변경 후보 이름을 보존하거나 `--no-rename`을 사용해야 한다. `getinfo/traceback`처럼 소스를 관찰하는 접근에는 이름 변경·공백 제거·문자열 숨김도 충돌한다. 필요한 경우 `--no-rename --no-minify --no-hide-strings`로 원문을 보존한다.
- 알려진 Lua loader에 정적으로 확정할 수 없는 소스·외부 파일·바이트코드가 들어가거나 loader·환경 테이블이 외부 함수, metatable, 반환값이나 전역으로 전달되면 보수적으로 변환을 거부한다. `require/package` 접근도 외부 코드의 관찰을 확정할 수 없어 거부한다. 이 경우 Lua 원문을 보존하면서 MPQ 최적화만 할 수 있다. 안전한 상수 loaded chunk와 일반 동적 native 조회는 허용한다.
- 완전히 계산된 이름으로 외부 reflection 기능을 조회하는 모든 경로까지 정적으로 증명하지는 않는다. 그런 코드에 의존하는 입력은 이름·공백·문자열 변환을 해제해야 한다.

동적 접근을 확인할 수 없는 전역·필드 이름 변경, 엔진 함수 외의 일반 함수 호출 숨김, 모델 변환, 범용 Lua VM, 런타임 변조·치트 방지, JASS 변환, 캠페인과 번역은 구현 범위에 포함하지 않는다. 정적으로 확인된 전역·닫힌 테이블 필드 이름 변경, 엔진 함수 호출 숨김, sector 크기 변경, 제한된 선택적 함수 VM과 런타임 문자열 모드는 실험적으로 제공한다.

에디터에서 전체 문자열을 깨뜨리는 기능은 제공하지 않는다. `war3map.wts`와 오브젝트의 이름·툴팁은 게임 UI와 native 조회에도 사용되며, LoTKT FileIO는 툴팁을 저장 데이터 전달에 사용한다. 문자열을 손상시키거나 나중에 native로 복원하면 표시·저장·초기화 시점이 바뀔 수 있다. 현재는 검토된 에디터·개발 파일 정리와 Lua 리터럴의 런타임 복원으로 보호하고, WTS·오브젝트·스킨과 리소스 경로는 보존한다. 에디터 전용 라벨은 게임 사용 여부를 확인한 필드만 별도 옵션으로 검토하며 게임 표시 문자열과 함께 일괄 변경하지 않는다.

## 검증과 프로젝트 경계

```powershell
npm run check
npm test
git diff --check
```

`check`는 ESLint 정적 검사 뒤 각 구현 모듈을 로드해 문법과 연결을 검사한다. 테스트는 Lua 재파싱·바인딩·문자열 바이트 검사, Fengari에서 원본/변환 코드 실행 결과 비교(전역·필드 이름 변경, 엔진 함수 지연 조회 포함), 동적 전역 조회 거부, sector 크기 변경 후 전체 블록·암호화·attributes 재읽기, 프리셋·CLI·Windows backend 설정 우선순위와 실패 전달·취소, 정리 계약의 전체 의존성 비교, 메모리 내 MPQ·맵 통합 회귀와 파일 출력의 덮어쓰기·중단 처리를 확인한다. 압축 전략 재읽기와 기본 전략의 기존 바이트 보존, 절감 합계, 설정 조합 비교, 입력·설정·계약 변경 시 재사용 거부와 보관 상한, 세션 종료·취소 후 재시작도 검증한다. 성능 회귀 테스트는 깊은 중첩 호출 분석과 파일 1만 개 아카이브 갱신을 제한 시간이 있는 별도 프로세스에서 실행한다. 테스트에서 실제 보호 맵은 생성하지 않는다. Windows 패키지 빌드는 GUI 컴파일과 화면 생성 smoke test, 포함된 런타임의 프리셋 응답을 검사한다. 별도 GUI 통합 smoke는 같은 화면 세션에서 검사·재사용·설정 미리보기·비교·선택 적용과 종료를 확인한다.

이 검사들은 실제 Warcraft III 엔진 실행, 멀티플레이 동기화, 시각 품질·성능 검증을 대신하지 않는다. 실제 게임 검증은 사용자가 수행한다. 게임 검증 후에도 편집용 원본과 보호 배포 사본을 별도로 유지한다.

게임에서는 초기 로딩·UI·리소스·native 등록, 기존 저장 데이터 읽기와 새 저장, 스킬·보스·피해·오더 동작을 확인한다. 2인 이상 환경에서 같은 실행 흐름의 동기화도 확인해야 한다. 문자열 숨김은 로딩 시간과 메모리, 리소스 표시는 시각 품질을 따로 비교한다. VM 대상은 반환값과 반복 실행 중 성능도 비교한다. 전역·필드 이름 변경과 엔진 함수 숨김은 모든 트리거·저장/불러오기·콜백 경로를, sector 크기 변경은 맵 로딩과 모든 리소스 표시를 확인한다. 정리 계약의 정적 검토만으로 이 항목이 검증되지는 않는다.

MPQ 기반은 LoTKT의 `build/mpq.mjs`에서 독립 복사한 뒤 이 저장소에서 확장했다. 실행 시 LoTKT 소스나 빌드 모듈을 import하지 않는다. LoTKT 빌드는 원래 저장소의 지침과 설정을 따른다.
