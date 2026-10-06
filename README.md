# WarcraftLuaProtector

Warcraft III Lua 맵의 이름을 난독화하고 배포 용량을 줄이는 로컬 도구다. LoTKT에서 빌드를 완료한 맵을 입력으로 사용하며, LoTKT 소스나 빌드 도구를 수정하지 않는다.

## 현재 구현

버전 0.7.0은 CLI와 Windows 파일 선택 화면을 제공한다. 모든 처리는 로컬에서 수행한다.

- Lua 5.3 문법과 lexical scope를 분석해 local 변수·함수·매개변수 이름을 결정적으로 변경한다. 참조가 많은 바인딩에 짧은 이름을 우선 배정하고, 캡처와 이름 가림이 충돌하지 않는 스코프에서 이름을 재사용한다.
- 토큰 단위로 주석과 불필요한 공백을 제거한다. 기본값에서는 전역/native/public 이름, `main/config`, `gg_*`·`udg_*`, 메서드 필드를 보존한다. 문자열 표기는 별도 옵션을 켠 경우에만 변경한다.
- 실험 옵션으로 정적 조회만 확인된 스크립트 정의 전역, 외부로 전달되지 않는 닫힌 테이블의 필드 이름을 변경하고, 엔진 함수 호출을 하나의 local 테이블 조회로 숨긴다. 동적 전역 조회를 확인할 수 없으면 거부한다. 자세한 규칙은 아래 [전역·필드 이름 변경과 엔진 함수 숨김](#전역필드-이름-변경과-엔진-함수-숨김-실험)에 있다.
- 변환 뒤 Lua를 재파싱하고, local 이름 외의 구문 구조와 변수 바인딩이 같은지 확인한다.
- 선택한 문자열 리터럴을 숫자 바이트 이스케이프로 숨긴다. 복원 함수·추가 호출 없이 Lua가 원래 바이트를 읽으며, 변환 뒤 모든 문자열의 바이트와 구문 구조를 확인한다.
- 선택한 seed로 짧은 local 이름의 배정을 다양화하는 `seeded` 모드를 제공한다. 기존 `compact` 모드와 기본 출력은 유지한다.
- 실험적인 `runtime` 문자열 모드는 ChaCha20 암호문을 4바이트 단위 숫자로 저장하고 순수 Lua로 복원한다. 원래 바이트를 처음 사용 시 복원해 내부 캐시에 보관하고 해당 암호문 테이블을 해제한다. 게임 난수·native·표준 라이브러리 호출에 의존하지 않는다. 복원 함수와 VM 해석기는 청크에서 쓰지 않는 가장 짧은 이름을 사용해 고정된 도구 식별 이름을 남기지 않는다.
- 명시적으로 지정한 local 함수에 제한된 전용 VM을 적용한다. 원본 함수의 수치·논리식과 조건 분기를 seed별 명령 데이터로 바꾸며, 지정하지 않은 코드의 구문 보존과 출력 재파싱을 검사한다.
- 지원 파일은 zlib 레벨·전략과 비압축 후보를 비교하고, 기존 payload보다 작아지는 경우에만 재압축한다. 기본은 이전과 같은 레벨 6·9와 `default` 전략이다. MPQ 빈 공간도 회수한다.
- 각 단계에서 MPQ를 재읽고, 변경하지 않은 파일의 packed payload·메타데이터·locale과 미열거 활성 블록을 검증한다. FIX_KEY 암호화 파일은 원래 offset을 유지한다.
- 실험 옵션으로 MPQ sector 크기를 바꿔 모든 활성 블록을 다시 압축한다. 내용·해시/locale 슬롯·블록 번호·크기·암호화를 유지하고 전체를 다시 읽어 확인한다. 아래 [MPQ 섹터 크기 변경](#mpq-섹터-크기-변경-실험)을 참고한다.
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
| `--hide-natives` / `--no-hide-natives` | 엔진 함수 호출을 local 테이블 조회로 숨기기 켜기 / 끄기 (실험) |
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
| `--cleanup-contract File.json` | 정확히 일치하는 입력 맵의 의존성 검토 계약 읽기 |
| `--review-cleanup` | 이전 계약과 두 입력 맵을 비교; 맵 출력 없음 |
| `--previous-input Map.w3x` | 이전 계약에 정확히 일치하는 검토 원본 |
| `--contract-output New.json` | 재포장 동일성이 확인된 계약 후보를 새 파일로 명시적 저장 |
| `--no-cleanup` | 설정 파일에서 켠 정리도 모두 해제 |
| `--no-compress` | 재압축 최적화 해제; MPQ 빈 공간 회수는 유지 |
| `--sector-size-shift N` | MPQ sector를 `512 × 2^N` 바이트(N = 3..8)로 바꾸고 전체 재압축 (실험) |
| `--keep-sector-size` | 설정 파일에서 지정한 sector 크기 변경 해제 |
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
| `maximum` | 최대 보호 | 보호 강화 + 전역·닫힌 테이블 필드 이름 변경 + 엔진 함수 호출 숨김(이름도 런타임 문자열로 암호화); 파일 정리·섹터 크기 변경은 별도 |

설정 우선순위는 기본값 → 프리셋 → JSON → CLI 또는 화면의 명시적 선택이다. 프리셋을 생략하면 기존 기본 동작을 사용한다. JSON 설정은 덮어쓰기 전에 엄격하게 검증하며 잘못된 값을 CLI로 가리지 않는다. 반복 보존·제외·VM 선택 옵션은 JSON 배열에 추가된다. `--no-vm`은 합친 VM 목록을 모두 비우며 다른 VM 선택보다 우선한다. `distribution --no-cleanup`은 파일 정리를 해제한다. `hardened`와 `maximum`에서만 문자열 숨김을 기본으로 켠다. 화면의 문자열 체크박스가 최종 활성 여부를 결정한다.

```powershell
npm run protect -- "C:\Maps\MyMap.w3x" --check --preset fast-check
npm run protect -- "C:\Maps\MyMap.w3x" --check --preset protect --hide-strings
npm run protect -- "C:\Maps\MyMap.w3x" --check --preset hardened --seed "release-2026-10"
npm run protect -- "C:\Maps\MyMap.w3x" --check --preset hardened --vm-function ReviewedCalculation
npm run protect -- "C:\Maps\MyMap.w3x" --check --preset maximum --seed "release-2026-10"
npm run protect -- "C:\Maps\MyMap.w3x" --check --preset maximum --sector-size-shift 7
npm run protect -- --show-settings --preset protect --config "settings.json"
npm run protect -- "C:\Maps\MyMap.w3x" --compare --cleanup-contract "reviewed.json"
npm run protect -- "C:\Maps\MyMap.w3x" --check --details --compression-strategy default --compression-strategy filtered
```

압축 전략은 `default`, `filtered`, `huffman-only`, `rle`, `fixed`다. 레벨과 전략의 모든 선택 조합을 기존 sector 구조 안에서 시험하고, 비압축·현재 packed 결과와 비교해 작은 것만 선택한다. 후보를 늘리면 처리 시간이 증가하며 모든 맵에서 추가 절감이 생기는 것은 아니다. locale·alias·암호화·미열거 파일의 보존 제한은 유지한다. `--no-compress`로 재압축을 끄면 추가 전략도 재압축에 사용하지 않는다.

## 보호 강화와 문자열 숨김

**기본값은 비활성화·`escape` 방식이다.** `--hide-strings`는 일반 메시지처럼 변환 가능한 리터럴을 `"\115\101..."` 형태로 표시한다. 원본과 복원한 문자열 바이트가 같은지 확인한다. **이 방식은 보호 기능이 아니라 표기 변환이다.** Lua 파서만으로 원문이 그대로 복원되며 소스가 길어진다. LoTKT 2.4E 측정에서 escape 방식은 축소 Lua의 4 KiB sector 압축 크기를 약 54 KB(3.5%) 늘렸다. 문자열을 숨기려면 `runtime` 방식을 사용한다.

두 방식 모두 4바이트 이하 값, ASCII 식별자 형태의 콜백·오더·WTS 이름, 경로·제어문자·툴팁 형식에 쓰이는 표기, 물리적으로 여러 줄인 리터럴을 보존한다. `--keep-string`과 `strings.keep`는 소스 표기 대신 디코딩한 UTF-8 값으로 비교한다. 빈 값이나 `--`로 시작하는 값도 `--keep-string=<값>` 또는 JSON 설정으로 지정할 수 있다.

`--hide-strings --string-mode runtime`은 [RFC 8439의 ChaCha20](https://www.rfc-editor.org/rfc/rfc8439#section-2.4) 20회전 알고리즘으로 암호문과 복원 함수를 만든다. 256비트 키와 nonce의 공통 부분은 seed·변환 입력 전체에서 SHA-512로 결정적으로 도출하며, 고유 문자열마다 다른 96비트 nonce를 사용한다. 기존 8비트 마스킹보다 강한 암호 알고리즘을 사용하지만, 키와 복원 함수가 맵에 포함돼 분석·추출은 가능하다. 복원 함수는 native 없이 실행되므로 분리해 일반 Lua에서 호출하면 모든 문자열을 얻을 수 있다. 이 방식은 소스 검색·정적 열람을 막는 수준의 보호다. seed나 키를 배포 후 비밀로 유지하지 않으며 복구 불가능성을 보장하지 않는다. Poly1305 인증이나 실행 중 변조 방지는 제공하지 않는다.

암호문은 4바이트당 정수 하나로 저장하고 중복 값은 공유한다. 최초 복원 결과를 캐시한 뒤 해당 암호문 테이블을 해제한다. 복원은 순수 Lua 연산·바이트 조회로 수행하며 `string/table` 라이브러리, 외부 파일·`load`와 게임 RNG에 의존하지 않는다. 원래 문자열만 helper 호출로 바뀌는지와 복원 바이트·호출 위치를 검증한다. RFC 단일·다중 블록 시험 벡터, 모든 바이트 값과 정수 상위 비트·블록 경계를 라이브러리를 열지 않은 Fengari에서 확인한다.

ChaCha20은 기존 마스킹보다 최초 사용 계산이 늘어난다. 짧은 문자열 1,743개를 모두 최초 복원한 Fengari 비교에서는 기존 약 77..79 ms, 새 방식 약 403..449 ms였고 캐시 사용은 두 방식 모두 약 2..5 ms였다. 이것은 합성 입력의 인터프리터 측정이며 Warcraft III의 로딩·FPS 결과가 아니다. 기본 `escape` 방식과 문자열 숨김 비활성화는 유지한다. 실제 엔진에서 최초 로딩·문자열 사용과 메모리를 비교한 뒤 강화 모드를 배포한다.

`--name-mode seeded --seed <값>`은 기본과 같은 짧은 이름 길이·스코프 규칙을 유지하며 배정 알파벳을 다양화한다. 같은 입력·seed·최종 설정은 재현한다. seed는 비밀 키가 아니며 소스를 정규화하는 분석 도구를 차단하지 않는다. 1..128자의 올바른 Unicode 문자열을 사용하며 제어문자와 줄바꿈은 허용하지 않는다. seed는 설정 확인과 캐시 일치 검사에 포함된다.

## 선택적 함수 VM (실험)

`lua.vmFunctions` 또는 `--vm-function`에 **변환 전 원본 이름**을 직접 지정한다. local 함수 중 같은 이름의 선언이 하나여야 하며, 중첩된 함수도 자기 매개변수와 내부 local만 참조하면 선택할 수 있다. 바깥 게임 상태나 upvalue를 읽는 함수는 거부한다. 전역/public/native·`main/config`·`gg_*`·`udg_*` 함수는 선택할 수 없다. 기본·보호 강화 프리셋 모두 함수를 자동 선택하지 않는다.

고정 매개변수, local 선언·대입, 수치·boolean·nil 리터럴, 산술·비트·비교·논리 연산, `if/elseif/else`·`do`, 최대 8개의 반환값을 지원한다. 원본 수치 리터럴의 표기를 그대로 기록해 JS의 정밀도·정수/실수 변환을 피한다. 다중 대입은 원래 RHS를 먼저 평가하고 단락 평가는 조건 분기로 보존한다. 같은 대입문에 중복된 대상은 저장 순서에 의존하므로 거부한다. 외부/upvalue·환경 조회, 함수·native 호출, 테이블·문자열 리터럴, 중첩 함수·vararg·루프·goto는 지원하지 않으며 선택이 있으면 명시적으로 거부한다. 지원 범위를 벗어난 함수를 건너뛰거나 부분 변환하지 않는다.

VM은 원본의 제한된 조건 분기를 명령 데이터와 해석 루프로 옮긴다. 해석기와 데이터가 배포 맵에 포함되므로 복구 불가능을 보장하지 않는다. 함수별 호출 시 내부 레지스터 테이블과 해석 비용이 생긴다. 피해·스킬·보스·타이머·고빈도 루프를 자동으로 대상으로 삼지 않는다. 적용 대상은 의존성·호출 빈도를 검토한 계산 함수부터 직접 선택하고 실제 게임·동기화를 시험한다. 전체 맵의 성능·메모리를 확인하기 전에는 정식 배포에 적용하지 않는다.

런타임 문자열·VM은 local/upvalue·소스·bytecode·메모리 관찰과 확인할 수 없는 외부 코드 로딩이 감지되면 거부한다. 생성 결과를 재파싱하고 Lua local/upvalue 수 한계도 확인한다. helper가 추가된 최종 코드에는 Fengari의 Lua 5.3 텍스트 컴파일 검사를 연결해 임시 레지스터 한계도 확인한다. 라이브러리를 열거나 맵 코드를 실행하지 않는다. Fengari의 정수 구현은 Warcraft III 엔진과 다를 수 있어 컴파일 성공을 게임 동작의 증명으로 해석하지 않는다. 해제하려면 `--no-runtime-strings --no-vm`을 사용한다. 원문 관찰과 충돌하는 기본 변환까지 해제해야 할 경우 기존 `--no-rename --no-minify --no-hide-strings`도 필요하다.

## 전역·필드 이름 변경과 엔진 함수 숨김 (실험)

세 옵션은 모두 기본값이 꺼져 있고 `maximum` 프리셋에서 함께 켜진다. 전역 이름과 테이블 필드는 다른 코드·엔진·문자열 조회가 이름으로 접근할 수 있으므로, 접근 경로를 모두 정적으로 확인한 경우에만 바꾼다.

**전역 이름 변경**(`lua.renameGlobals`)은 스크립트가 대입하거나 `function Name()`으로 정의한 전역만 대상으로 한다. 다음 이름은 바꾸지 않는다.

- `src/engine-names.mjs`의 엔진 이름(로컬 World Editor `common.j`·`Blizzard.j`의 native·함수·전역 선언, Lua 기본 라이브러리, `FourCC`·`__jarray`), `main/config`, `gg_*`·`udg_*`, `lua.keepGlobals`
- 정확히 식별자 형태인 문자열 리터럴과 같은 이름(`ExecuteFunc("Name")`, `_G["Name"]`, `TriggerRegisterVariableEvent`의 변수 이름 등)
- `_G[key]`의 key를 상수·상수 연결, local 정의, 직접 호출만 되는 local 함수의 인자로 추적해 얻은 이름
- 로딩 중 처음 정의가 끝나기 전에 읽히는 전역(엔진 값을 감싸는 hook 형태)

`_ENV`, 값으로 전달되거나 저장되는 `_G`(예: `pairs(_G)`, `rawget(_G, k)`), 추적할 수 없는 `_G[key]`, `load/loadfile/dofile/require/debug/package`, 이름을 정적으로 알 수 없는 `ExecuteFunc`·`TriggerRegisterVariableEvent`가 하나라도 있으면 원인 위치와 함께 거부한다. 새 이름은 엔진 이름·보존 이름·문자열로 조회되는 이름과 겹치지 않으며, local 이름과 같은 스코프 충돌 규칙으로 배정한다. 변환 뒤 모든 참조가 같은 전역 또는 같은 local에 연결되는지 다시 확인한다.

`common.j`·`Blizzard.j`에 없는 최신 패치 native를 스크립트가 다시 정의하면 위 hook 검사로만 보호된다. 이런 이름이 있으면 `--keep-global`로 보존한다. 엔진 이름 목록은 파일 머리의 SHA-256과 같은 `common.j`·`Blizzard.j`에서 native·function·globals 선언 이름만 모은 것이다. 새 패치의 선언 파일로 같은 규칙에 따라 다시 만들 수 있다.

**닫힌 테이블 필드 이름 변경**(`lua.renameFields`)은 문자열 키만 가진 생성자로만 값이 정해지고, 모든 사용이 `T.name`·`T:name()`·`function T.name`·`function T:name` 형태인 테이블에 적용한다. 테이블이 인자·반환값·다른 변수·테이블에 전달되거나, 동적 인덱스·`pairs`·metatable에 쓰이면 바꾸지 않는다. 콜론 호출은 테이블을 `self`로 넘기므로 해당 필드가 콜론 메서드로만 정의되고 그 메서드의 `self`도 같은 조건을 만족할 때만 허용한다. 필드 이름은 테이블마다 독립적으로 짧은 이름을 배정한다.

**엔진 함수 호출 숨김**(`lua.hideNatives`)은 엔진 native·Blizzard 함수 참조를 하나의 local 테이블 조회(`t[3](...)`)로 바꾼다. 테이블은 처음 접근할 때 같은 이름의 전역을 읽어 함수 값을 보관하므로 엔진 초기화 순서와 무관하다. 스크립트가 대입하거나 `_G.Name =`으로 바꾸는 이름, 값이 바뀌는 엔진 전역 변수(`bj_*`·상수)는 바꾸지 않는다. 동적 `_G` 대입 등 전역 분석을 확인할 수 없으면 거부한다. 런타임 문자열을 함께 켜면 테이블의 함수 이름 목록도 ChaCha20으로 암호화한다. 오류 메시지의 함수 이름 표시는 달라질 수 있다.

2026-10-06에 `LoTKT 2.4E.w3x`(Lua 8,152,905바이트)를 메모리에서 검사한 결과는 다음과 같다. 정적 검사와 Fengari 컴파일 검사만 수행했으며 게임 실행 결과가 아니다.

| 설정 | 변경 | 맵 크기 |
| --- | --- | --- |
| `protect` | local 47,806개 | 59,727,097 |
| `hardened` | + 런타임 문자열 2,588개 | 59,776,870 |
| `maximum` | + 전역 3,570개, 닫힌 테이블 588개의 필드 1,287개, 엔진 함수 564개 | 59,534,925 |
| `maximum --sector-size-shift 7` | + 64 KiB sector | 52,736,894 |

`_G` 전체를 순회하는 디버그 라이브러리가 있는 맵처럼 거부되는 입력은 `--no-rename-globals --no-rename-fields --no-hide-natives`로 해당 옵션만 해제한다. 작은 맵에서는 런타임 복원 함수의 고정 크기 때문에 맵이 커질 수 있다.

## MPQ 섹터 크기 변경 (실험)

World Editor 맵은 4 KiB sector(shift 3)를 사용하며 각 sector를 독립적으로 압축한다. `compression.sectorSizeShift` 또는 `--sector-size-shift N`은 sector를 `512 × 2^N` 바이트(N = 3..8)로 바꾸고 모든 활성 블록을 다시 압축한다. LoTKT 2.4E의 축소 Lua는 4 KiB에서 1,536,074바이트, 64 KiB에서 991,000바이트였고, 맵 전체 zlib 9 추정치는 61.2 MB에서 53.2 MB였다.

모든 활성 블록을 디코딩할 수 있어야 한다. 이름은 `(listfile)`과 알려진 내부 파일에서 찾으며, 암호화 블록은 정확히 하나의 알려진 이름이 필요하다. FIX_KEY 블록은 새 offset으로 다시 암호화한다. 해시·locale 슬롯, 블록 번호, 원본 크기, 암호화 플래그와 attributes 내용을 유지하고 압축 비트·offset·packed 크기만 바뀐다. PKWARE·single-unit·sector CRC 등 지원하지 않는 블록이 있으면 중단한다. 재압축 제외 목록과 함께 사용할 수 없고 재압축을 켜야 한다.

**Warcraft III가 4 KiB가 아닌 sector 크기를 읽는지는 이 도구가 확인하지 않는다.** 정적 검사는 MPQ 재읽기만 증명한다. 배포 전에 테스트 맵으로 로딩·모든 리소스 표시·저장 데이터·멀티플레이를 직접 확인하고, 문제가 있으면 `--keep-sector-size`로 되돌린다.

## 파일 정리

**기본값은 파일 정리 비활성화다.** LoTKT에는 동적 `Preloader`와 전역 조회가 있어 파일 이름 검색만으로 실행 의존성을 확정할 수 없다. 기본 실행은 모든 에디터·개발·리소스 파일을 보존한다.

고급 설정에서 **에디터 파일 정리·개발 파일 정리**를 켠 경우도 같은 검사를 적용한다. `Preloader` 오류는 실행 파일 사용 여부를 확인하지 못해 삭제를 중단했다는 뜻이다. 정리하려면 메인 **작업** 화면의 **검토 계약 → 찾아보기**에서 현재 입력 맵을 검토한 JSON을 선택한 뒤 검사한다. 일치하는 계약이 없으면 두 정리 옵션을 해제한다. Lua 보호·문자열 숨김·재압축은 정리를 끈 상태에서도 사용할 수 있다. 프리셋을 바꾸거나 검사 버튼만 다시 눌러 이 조건을 우회하지 않는다.

정리는 위의 명시 옵션 또는 JSON 설정으로 켠다. 대상은 에디터 트리거 데이터 두 파일과 `lotkt-object-history.json`, `lotkt-object-receipt.json`뿐이다. 모델·텍스처·오브젝트·스킨·일반 import나 이름 미확인 파일을 미사용으로 추측해 삭제하지 않는다.

정리 후보의 문자열 참조는 Lua escape와 상수 문자열 연결까지 확인한다. 파일 로더, `debug/package`, 확인할 수 없는 `_G/_ENV` 접근 또는 환경 테이블 별칭이 있으면 정리를 거부한다. 이 경우 `--no-cleanup` 또는 필요한 후보의 `--keep-file`로 보존한다.

동적 저장 기능과 native 조회가 있는 LoTKT 입력에는 별도 의존성 검토가 필요하다. `cleanup/lotkt-contract.json`은 현재 검토한 기존 빌드 산출물 하나에만 적용하는 계약이다. 맵 전체와 원본 Lua의 SHA-256, 동적 파일 접근·오브젝트·import 검토 근거, 각 삭제 후보의 이유와 한계를 포함한다. 파일 이름 검색만으로 정리를 허용하지 않으며 계약은 도구가 생성한 안전성 증명이 아니다.

계약은 파일명이나 버전명이 같은 다른 맵에 재사용할 수 없다. 새 빌드와 이미 보호한 사본은 원본 맵·Lua 해시가 달라질 수 있다. Windows 패키지의 `cleanup` 폴더에도 검토 계약을 포함하지만, 현재 입력과 정확히 일치하는 계약을 직접 선택해야 한다. 이전 계약을 선택하면 불일치 오류로 중단한다.

2026-10-06에 검토한 `LoTKT/dist/LoTKT 2.4E.w3x`에는 `cleanup/lotkt-2.4e-2026-10-06-contract.json`을 사용한다. 검토본의 맵 SHA-256은 `7fb4bd96153b66560160d534bae4e9a9cd90e63aff464ab3c18d59de89612e63`이다. 저장 파일·native 조회와 모든 활성 파일, 오브젝트·스킨·import·모델을 실제 입력 기준으로 검토했다. receipt의 원본 sourceHash에 해당하는 맵은 식별하지 못했으며 provenance 검증을 했다고 주장하지 않는다. 외부 저장 파일은 기존 FileIO 형식으로 가정하고, 외부 주입 스크립트·애드온과 실제 게임 검증은 범위 밖이다. 이후 다시 빌드한 2.4E에는 이 계약도 일치하지 않을 수 있다.

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

삭제한 파일에 대응하는 `war3map.imp` 행과 MPQ `(listfile)` 항목도 정리한다. 지원하지 않는 import 형식이나 손상 데이터는 중단한다. 특정 파일 보존 설정은 이름의 대소문자와 `/`·`\` 차이를 무시한다.

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
    "hideNatives": false
  },
  "strings": {
    "enabled": false,
    "keep": [],
    "mode": "escape"
  },
  "cleanup": {
    "editor": false,
    "development": false,
    "keepFiles": []
  },
  "compression": {
    "enabled": true,
    "levels": [6, 9],
    "strategies": ["default"],
    "excludeFiles": [],
    "sectorSizeShift": null
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

`check`는 각 구현 모듈을 로드해 문법과 연결을 검사한다. 테스트는 Lua 재파싱·바인딩·문자열 바이트 검사, Fengari에서 원본/변환 코드 실행 결과 비교(전역·필드 이름 변경, 엔진 함수 지연 조회 포함), 동적 전역 조회 거부, sector 크기 변경 후 전체 블록·암호화·attributes 재읽기, 프리셋·CLI·Windows backend 설정 우선순위와 실패 전달·취소, 정리 계약의 전체 의존성 비교, 메모리 내 MPQ·맵 통합 회귀와 파일 출력의 덮어쓰기·중단 처리를 확인한다. 압축 전략 재읽기와 기본 전략의 기존 바이트 보존, 절감 합계, 설정 조합 비교, 입력·설정·계약 변경 시 재사용 거부와 보관 상한, 세션 종료·취소 후 재시작도 검증한다. 테스트에서 실제 보호 맵은 생성하지 않는다. Windows 패키지 빌드는 GUI 컴파일과 화면 생성 smoke test, 포함된 런타임의 프리셋 응답을 검사한다. 별도 GUI 통합 smoke는 같은 화면 세션에서 검사·재사용·설정 미리보기·비교·선택 적용과 종료를 확인한다.

이 검사들은 실제 Warcraft III 엔진 실행, 멀티플레이 동기화, 시각 품질·성능 검증을 대신하지 않는다. 실제 게임 검증은 사용자가 수행한다. 게임 검증 후에도 편집용 원본과 보호 배포 사본을 별도로 유지한다.

게임에서는 초기 로딩·UI·리소스·native 등록, 기존 저장 데이터 읽기와 새 저장, 스킬·보스·피해·오더 동작을 확인한다. 2인 이상 환경에서 같은 실행 흐름의 동기화도 확인해야 한다. 문자열 숨김은 로딩 시간과 메모리, 리소스 표시는 시각 품질을 따로 비교한다. VM 대상은 반환값과 반복 실행 중 성능도 비교한다. 전역·필드 이름 변경과 엔진 함수 숨김은 모든 트리거·저장/불러오기·콜백 경로를, sector 크기 변경은 맵 로딩과 모든 리소스 표시를 확인한다. 정리 계약의 정적 검토만으로 이 항목이 검증되지는 않는다.

MPQ 기반은 LoTKT의 `build/mpq.mjs`에서 독립 복사한 뒤 이 저장소에서 확장했다. 실행 시 LoTKT 소스나 빌드 모듈을 import하지 않는다. LoTKT 빌드는 원래 저장소의 지침과 설정을 따른다.

기능 참고: [W3Protect 소개](https://w3protect.eu/). 공개 기능을 참고한 독자 구현이며 동일한 내부 구현이나 보호 강도를 보장하지 않는다. 형식 참고: [W3I 28..33 명세](https://github.com/ChiefOfGxBxL/WC3MapSpecification/blob/master/Info/0-33.md), [wc3libs W3I](https://github.com/inwc3/wc3libs/blob/master/src/main/java/net/moonlightflower/wc3libs/bin/app/W3I.java), [wc3libs IMP](https://github.com/inwc3/wc3libs/blob/master/src/main/java/net/moonlightflower/wc3libs/bin/app/IMP.java). Lua 파싱은 [luaparse](https://github.com/fstirlitz/luaparse)를 사용한다.
