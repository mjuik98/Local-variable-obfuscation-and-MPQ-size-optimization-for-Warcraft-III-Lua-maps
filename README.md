# WarcraftLuaProtector

Warcraft III Lua 맵의 local 이름을 난독화하고 배포 용량을 줄이는 로컬 도구다. LoTKT에서 빌드를 완료한 맵을 입력으로 사용하며, LoTKT 소스나 빌드 도구를 수정하지 않는다.

## 현재 구현

기본 CLI 버전 0.1.0을 구현했다. 파일 선택 화면이나 웹 서비스는 포함하지 않는다.

- Lua 5.3 문법과 lexical scope를 분석해 local 변수·함수·매개변수 이름을 결정적으로 변경한다.
- 토큰 단위로 주석과 불필요한 공백을 제거한다. 전역/native/public 이름, `main/config`, `gg_*`·`udg_*`, 메서드 필드와 문자열 토큰은 보존한다.
- 변환 뒤 Lua를 재파싱하고, local 이름 외의 구문 구조와 변수 바인딩이 같은지 확인한다.
- 지원 파일은 zlib 6·9와 비압축 후보를 비교하고, 기존 payload보다 작아지는 경우에만 재압축한다. MPQ 빈 공간도 회수한다.
- 각 단계에서 MPQ를 재읽고, 변경하지 않은 파일의 packed payload·메타데이터·locale과 미열거 활성 블록을 검증한다. FIX_KEY 암호화 파일은 원래 offset을 유지한다.
- 설정으로 local 이름 보존, 파일 정리 후보 보존, 재압축 제외와 각 변환의 비활성화를 지원한다.
- 입력은 읽기 전용이다. 결과를 검증한 뒤 새로운 출력 경로에만 확정하며 기존 파일은 덮어쓰지 않는다.

이름 난독화는 소스 분석 비용을 높이는 기본 보호다. 에디터 열기 방지나 복구 불가능성을 보장하지 않는다. 용량 최적화는 실행 속도 개선을 뜻하지 않으며, 모든 입력에서 전체 맵 크기가 줄어드는 것도 보장하지 않는다.

## 사용

Node.js 22 이상이 필요하다. 저장소 폴더에서 실행한다.

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
| `--no-minify` / `--no-rename` | 공백·주석 제거 / local 이름 변경 해제 |
| `--clean-editor` | 참조 검사 후 `war3map.wtg`, `war3map.wct` 정리 |
| `--clean-development` | 참조 검사 후 LoTKT 개발 메타데이터 두 파일 정리 |
| `--no-cleanup` | 설정 파일에서 켠 정리도 모두 해제 |
| `--no-compress` | 재압축 최적화 해제; MPQ 빈 공간 회수는 유지 |
| `--keep-local Name` | 해당 local 이름의 모든 바인딩 보존; 반복 지정 가능 |
| `--keep-file Path` | 정리 후보 보존; 반복 지정 가능 |
| `--exclude-compress Path` | 해당 파일의 추가 재압축 제외; 반복 지정 가능 |

재압축 제외는 내용 보존 파일의 추가 최적화에 적용한다. 변환된 Lua나 수정된 import manifest를 MPQ에 다시 기록하는 과정은 그대로 수행한다.

## 파일 정리

**기본값은 파일 정리 비활성화다.** LoTKT에는 동적 `Preloader`와 전역 조회가 있어 파일 이름 검색만으로 실행 의존성을 확정할 수 없다. 기본 실행은 모든 에디터·개발·리소스 파일을 보존한다.

정리는 위의 명시 옵션 또는 JSON 설정으로 켠다. 대상은 에디터 트리거 데이터 두 파일과 `lotkt-object-history.json`, `lotkt-object-receipt.json`뿐이다. 모델·텍스처·오브젝트·스킨·일반 import나 이름 미확인 파일을 미사용으로 추측해 삭제하지 않는다.

정리 후보의 문자열 참조는 Lua escape와 상수 문자열 연결까지 확인한다. 파일 로더, `debug/package`, 확인할 수 없는 `_G/_ENV` 접근 또는 환경 테이블 별칭이 있으면 정리를 거부한다. 이 경우 `--no-cleanup` 또는 필요한 후보의 `--keep-file`로 보존한다. 기존 LoTKT 빌드의 동적 저장 기능도 이 거부 조건에 해당한다.

삭제한 파일에 대응하는 `war3map.imp` 행과 MPQ `(listfile)` 항목도 정리한다. 지원하지 않는 import 형식이나 손상 데이터는 중단한다. 특정 파일 보존 설정은 이름의 대소문자와 `/`·`\` 차이를 무시한다.

## 설정 예시

```json
{
  "lua": {
    "minify": true,
    "renameLocals": true,
    "keepLocals": []
  },
  "cleanup": {
    "editor": false,
    "development": false,
    "keepFiles": []
  },
  "compression": {
    "enabled": true,
    "levels": [6, 9],
    "excludeFiles": []
  }
}
```

생략한 항목은 위 기본값을 사용한다. 알 수 없는 키나 잘못된 값은 오류로 전달한다. CLI 옵션이 설정 파일보다 우선하고 반복 보존·제외 옵션은 기존 배열에 추가된다. 같은 입력·설정과 같은 Node/zlib 환경에서 같은 결과를 만든다. 게임의 난수 호출이나 등록·실행 순서는 추가하거나 변경하지 않는다.

## 지원 범위와 제한

- 입력은 `.w3x/.w3m`, raw MPQ 또는 `HM3W` prefix가 있는 MPQ v0, 루트 `war3map.lua`를 사용하는 Lua 맵이다.
- `war3map.w3i` 버전 28..33 및 39의 스크립트 언어 필드를 확인한다. 맵 정보와 terrain의 전체 내용을 해석하거나 다시 쓰지는 않는다.
- 루트 Lua의 UTF-8 바이트, top-level `main/config`와 terrain의 존재를 검사한다. JASS 선택, 중복·혼합 스크립트, 미지원 맵 정보, 잘못된 UTF-8은 거부한다.
- 변경에 필요한 파일은 비압축 또는 지원 zlib 형식으로 읽을 수 있어야 한다. 읽기 미지원인 다른 파일은 opaque payload 그대로 보존하고 재압축하지 않는다. 손상된 지원 압축 데이터는 오류로 중단한다.
- 여러 locale·alias를 가진 파일은 독립 교체하지 않는다. 일반 재압축은 단일 locale·비alias·비암호화 파일로 제한한다. 미열거 파일은 추가 압축 대상으로 추측하지 않는다.
- 서명, 후행 데이터, 미지원 MPQ 버전, 잘못된 범위·중첩, 미지원 attributes 구조와 검증 실패는 중단한다.
- local/upvalue 이름을 관찰하는 reflection은 이름 변경과 충돌한다. 감지된 경우 모든 변경 후보 이름을 보존하거나 `--no-rename`을 사용해야 한다. `getinfo/traceback`처럼 줄·소스 위치를 관찰하는 접근에는 `--no-minify`도 필요하다.
- 알려진 Lua loader에 정적으로 확정할 수 없는 소스·외부 파일·바이트코드가 들어가거나 loader·환경 테이블이 외부 함수, metatable, 반환값이나 전역으로 전달되면 보수적으로 변환을 거부한다. `require/package` 접근도 외부 코드의 관찰을 확정할 수 없어 거부한다. 이 경우 `--no-rename --no-minify`로 Lua 원문을 보존하면서 MPQ 최적화만 할 수 있다. 안전한 상수 loaded chunk와 일반 동적 native 조회는 허용한다.
- 완전히 계산된 이름으로 외부 reflection 기능을 조회하는 모든 경로까지 정적으로 증명하지는 않는다. 그런 코드에 의존하는 입력은 이름·공백 변환을 해제해야 한다.

문자열 숨김, global 이름 변경, 함수 호출 숨김, 모델 변환, Lua VM, 런타임 변조·치트 방지, JASS 변환, 캠페인과 번역은 구현 범위에 포함하지 않는다.

## 검증과 프로젝트 경계

```powershell
npm run check
npm test
git diff --check
```

`check`는 각 구현 모듈을 로드해 문법과 연결을 검사한다. 테스트는 Lua 재파싱·바인딩 검사, Fengari에서 원본/변환 코드 실행 결과 비교, 메모리 내 MPQ·맵 통합 회귀와 파일 출력의 덮어쓰기·중단 처리를 확인한다. 테스트에서 실제 보호 맵은 생성하지 않는다.

이 검사들은 실제 Warcraft III 엔진 실행, 멀티플레이 동기화, 시각 품질·성능 검증을 대신하지 않는다. 실제 게임 검증은 사용자가 수행한다. 게임 검증 후에도 편집용 원본과 보호 배포 사본을 별도로 유지한다.

MPQ 기반은 LoTKT의 `build/mpq.mjs`에서 독립 복사한 뒤 이 저장소에서 확장했다. 실행 시 LoTKT 소스나 빌드 모듈을 import하지 않는다. LoTKT 빌드는 원래 저장소의 지침과 설정을 따른다.

기능 참고: [W3Protect 소개](https://w3protect.eu/). 공개 기능을 참고한 독자 구현이며 동일한 내부 구현이나 보호 강도를 보장하지 않는다. 형식 참고: [W3I 28..33 명세](https://github.com/ChiefOfGxBxL/WC3MapSpecification/blob/master/Info/0-33.md), [wc3libs W3I](https://github.com/inwc3/wc3libs/blob/master/src/main/java/net/moonlightflower/wc3libs/bin/app/W3I.java), [wc3libs IMP](https://github.com/inwc3/wc3libs/blob/master/src/main/java/net/moonlightflower/wc3libs/bin/app/IMP.java). Lua 파싱은 [luaparse](https://github.com/fstirlitz/luaparse)를 사용한다.
