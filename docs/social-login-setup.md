# 카카오·구글 로그인 활성화

앱 코드는 Supabase Auth로 로그인하고, 로그인한 계정에 프로필과 여행 멤버를 연결합니다. Google/Kakao의 Client Secret은 Supabase에만 입력합니다. GitHub 코드나 채팅에 비밀 값을 넣지 마세요.

## 1. 계정용 SQL 적용

기존 `supabase/setup.sql`이 적용된 프로젝트의 SQL Editor에서 **supabase/auth.sql 전체 내용**을 새 쿼리에 붙여 넣고 Run을 누르세요. 새 계정용 테이블과 API를 추가하며 기존 여행과 초대 링크를 보존합니다. 재실행할 수 있습니다. `tests/`와 `*-tests.sql` 파일은 로컬 테스트 전용이므로 실제 프로젝트에서 실행하지 않습니다.

## 2. Supabase의 앱 주소

Authentication → URL Configuration에서 다음을 등록합니다.

- Site URL: `https://namugica.github.io/moa/`
- Redirect URLs: `https://namugica.github.io/moa/`

로컬 브라우저에서 직접 소셜 로그인할 경우에만 해당 로컬 주소도 Redirect URLs에 추가하세요. 예: `http://127.0.0.1:8000/`. 이 앱은 OAuth 성공 후 같은 경로로 돌아오고, 진행하던 초대 화면은 브라우저에 보관했다가 복구합니다.

## 3. 구글

[Supabase 공식 구글 설정 문서](https://supabase.com/docs/guides/auth/social-login/auth-google)를 참고하세요. 콘솔 화면 이름은 변경될 수 있습니다.

1. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트를 만들거나 선택합니다.
2. Google Auth Platform/OAuth 동의 화면에 앱 이름과 지원 이메일을 등록합니다.
3. 웹 애플리케이션 유형의 OAuth Client를 만듭니다.
4. Authorized redirect URI에 아래 **Supabase 콜백**을 등록합니다.

   `https://przrretbwgbdhadmmyop.supabase.co/auth/v1/callback`

5. Supabase Authentication → Sign In / Providers → Google에서 Enable을 켜고, 발급받은 Client ID와 Client Secret을 입력해 저장합니다.
6. Google 앱이 테스트 상태라면 로그인할 친구들의 계정을 테스트 사용자로 등록하세요. 일반 사용자 공개는 Google 콘솔의 게시/검증 요건에 맞춰 진행합니다.

브라우저 앱에는 Google Client Secret을 추가하지 않습니다. 콜백 URL과 MOA의 최종 Redirect URL은 서로 다릅니다.

## 4. 카카오

[Supabase 공식 카카오 설정 문서](https://supabase.com/docs/guides/auth/social-login/auth-kakao)를 참고하세요.

1. [Kakao Developers](https://developers.kakao.com/)에서 앱을 만듭니다.
2. 웹 플랫폼의 사이트 도메인에 `https://namugica.github.io`를 등록합니다.
3. 카카오 로그인을 활성화하고 Redirect URI에 아래 콜백을 등록합니다.

   `https://przrretbwgbdhadmmyop.supabase.co/auth/v1/callback`

4. 동의 항목에서 프로필/이메일 등 Supabase 카카오 공급자가 요구하는 항목을 설정합니다. 카카오의 이메일 권한은 앱 유형과 승인 상태에 따라 달라질 수 있습니다. 필요한 이메일 동의를 받을 수 없다면 공식 문서의 현재 요구 사항을 먼저 확인하세요.
5. 카카오 앱의 REST API 키를 Client ID로 사용합니다. Client Secret을 발급·활성화한 경우 그 값을 Supabase의 Client Secret에 입력합니다. Supabase 설정 화면이 요구하는 값에 맞춰 입력합니다.
6. Supabase Authentication → Sign In / Providers → Kakao에서 Enable을 켜고 저장합니다.

앱 코드에는 카카오 REST API 키나 Client Secret을 넣지 않습니다. 인증은 Supabase의 `/auth/v1/authorize?provider=kakao`를 통해 진행됩니다.

## 5. 실제 서비스 확인

설정을 마친 뒤 새 코드를 GitHub Pages에 배포하고 다음을 확인합니다.

1. 로그인 → 구글 또는 카카오 선택 → 최초 프로필 이름/아이콘 설정
2. 여행 생성 → 친구 초대 → 공통 링크 복사
3. 다른 계정이 같은 링크에서 로그인하고 자기 프로필로 참여
4. 지출을 추가했을 때 전체 내역은 같고 ‘나의 정산’은 각자 다르게 표시
5. 새 브라우저에서 동일 계정으로 로그인하면 여행이 복구
6. 로그아웃하면 해당 계정의 여행이 화면에서 사라짐

여행별 공통 링크는 7일 동안 여러 계정이 사용할 수 있습니다. 같은 계정이 다시 참여하면 기존 멤버를 사용합니다. 기존 개인 여행은 초대할 때 계정에 연결됩니다. 기존 개별 초대 링크를 로그인 후 수락하면 해당 멤버가 계정에 연결됩니다.

같은 이름만으로 두 계정을 합치지 않습니다. Google/Kakao의 동일한 검증된 이메일에 대한 자동 계정 연결은 Supabase의 설정·공급자 정책을 따릅니다. 서로 다른 이메일 계정을 수동으로 합치는 UI는 이번 변경에 포함되지 않았으므로 같은 여행을 이어가려면 처음 사용한 계정으로 로그인하세요.

## 검증 범위

로컬 테스트는 실제 PostgreSQL RPC와 모의 Google/Kakao 응답을 함께 사용해 PKCE 복귀, 계정 접근 권한, 공통 초대, 프로필, 다른 기기의 여행 복구, 로그아웃 후 화면 분리를 검증합니다. 실제 공급자의 동의 화면과 계정 인증은 위 외부 설정이 완료된 뒤 별도로 확인해야 합니다. 공급자가 꺼져 있으면 앱은 준비 중 안내를 표시합니다.
