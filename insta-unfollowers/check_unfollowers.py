import getpass
from instagrapi import Client

def main():
    print("=== 인스타그램 맞팔 확인 ===\n")

    import sys
    if not sys.stdin.isatty():
        username = sys.stdin.readline().strip()
        password = sys.stdin.readline().strip()
    else:
        username = input("인스타그램 아이디: ").strip()
        password = getpass.getpass("비밀번호 (입력해도 안 보여요): ")

    cl = Client()

    print("\n로그인 중...")
    try:
        cl.login(username, password)
    except Exception as e:
        print(f"로그인 실패: {e}")
        return

    print("로그인 성공!\n")

    user_id = cl.user_id

    print("팔로잉 목록 가져오는 중...")
    following = cl.user_following(user_id)  # {user_id: UserShort}

    print(f"팔로워 목록 가져오는 중... (팔로워가 많으면 시간이 걸려요)")
    followers = cl.user_followers(user_id)  # {user_id: UserShort}

    following_ids = set(following.keys())
    follower_ids = set(followers.keys())

    not_following_back = following_ids - follower_ids

    print(f"\n{'='*40}")
    print(f"내가 팔로우 중: {len(following_ids)}명")
    print(f"나를 팔로우 중: {len(follower_ids)}명")
    print(f"맞팔 안 하는 사람: {len(not_following_back)}명")
    print(f"{'='*40}\n")

    if not_following_back:
        print("나를 맞팔 안 하는 계정 목록:")
        for uid in not_following_back:
            user = following[uid]
            print(f"  @{user.username}  ({user.full_name})")

        # 파일로도 저장
        with open("unfollowers.txt", "w", encoding="utf-8") as f:
            f.write(f"맞팔 안 하는 계정 ({len(not_following_back)}명)\n")
            f.write("="*40 + "\n")
            for uid in not_following_back:
                user = following[uid]
                f.write(f"@{user.username}  ({user.full_name})\n")
        print("\nunfollowers.txt 파일로도 저장했어요.")
    else:
        print("모두 맞팔 중이에요!")

    cl.logout()

if __name__ == "__main__":
    main()
