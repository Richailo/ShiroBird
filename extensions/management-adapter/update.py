"""Build, test and activate a specified upstream NetBird release with ShiroBird."""
import argparse
from release import build
from rollout import activate

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('version', help='explicit upstream version, e.g. 0.81.3')
    parser.add_argument('--build-only', action='store_true')
    parser.add_argument('--work-root', default='/opt/shirobird/releases')
    parser.add_argument('--compose', default='/opt/netbird/docker-compose.yml')
    parser.add_argument('--config', default='/etc/shirobird/native-flow.json')
    parser.add_argument('--secret', default='/etc/shirobird/native-flow-secret')
    parser.add_argument('--health-url', default='http://127.0.0.1:8081/api/peers')
    args = parser.parse_args()
    release = build(args.version, args.work_root)
    if not args.build_only:
        activate(release, args.compose, args.config, args.secret, args.health_url)
