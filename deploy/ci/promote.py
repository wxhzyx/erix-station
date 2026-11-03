#!/usr/bin/env python3
"""Installed root-owned on the dedicated Station host; trusted main releases only."""
import datetime
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
import urllib.request

BASE = pathlib.Path('/var/lib/fde-station')
ENV = pathlib.Path('/opt/fde-station/deploy/.env')
COMPOSE = pathlib.Path('/opt/fde-station/deploy/docker-compose.yml')
WRAPPER = '/usr/local/sbin/fde-station-compose'


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def output(args):
    return subprocess.check_output(args, text=True).strip()


def portal_query(sql):
    code = "import pg from 'pg';const p=new pg.Pool({connectionString:process.env.DATABASE_URL});try{console.log(JSON.stringify((await p.query(" + json.dumps(sql) + ")).rows))}finally{await p.end()}"
    return json.loads(output(['docker','exec','station-portal','node','--input-type=module','-e',code]))


def health(revision, names):
    for _ in range(60):
        try:
            with urllib.request.urlopen('http://127.0.0.1:18080/healthz', timeout=3) as r:
                assert r.status == 200
            if revision:
                with urllib.request.urlopen('http://127.0.0.1:18080/version.json', timeout=3) as r:
                    assert json.load(r)['revision'] == revision
            for name in names:
                state = json.loads(output(['docker','inspect',name,'--format','{{json .State}}']))
                assert state['Running'] and state.get('Health',{}).get('Status') == 'healthy'
            return
        except Exception:
            time.sleep(2)
    raise RuntimeError('release health/revision/FDE heartbeat verification failed')


def main():
    if os.geteuid() != 0 or len(sys.argv) != 3:
        raise RuntimeError('root installer requires workspace and commit')
    workspace = pathlib.Path(sys.argv[1]).resolve()
    sha = sys.argv[2]
    if not workspace.is_relative_to('/var/lib/fde-ci/work') or not re.fullmatch('[a-f0-9]{40}',sha):
        raise RuntimeError('invalid release workspace or revision')
    manifest = json.loads((workspace/'release-manifest.json').read_text())
    if manifest['revision'] != sha:
        raise RuntimeError('manifest revision mismatch')
    for name in ['portal','runner','proxy']:
        image = manifest['images'][name]
        if not re.fullmatch('sha256:[a-f0-9]{64}',image):
            raise RuntimeError('immutable image ID required')
        revision = output(['docker','image','inspect',image,'--format','{{index .Config.Labels "org.opencontainers.image.revision"}}'])
        if revision != sha:
            raise RuntimeError('image revision mismatch')
    if portal_query("SELECT count(*)::int AS count FROM runs WHERE status IN ('queued','running','cancelling')")[0]['count']:
        raise RuntimeError('active work runs: deployment deferred; rerun after users finish')
    # A chat completion holds a DB advisory transaction lock. Conservatively defer
    # for any outstanding advisory lock rather than interrupting a live response.
    if portal_query("SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND pid<>pg_backend_pid()")[0]['count']:
        raise RuntimeError('active platform operation: deployment deferred')
    rows = portal_query("SELECT c.container_name FROM containers c JOIN users u ON u.id=c.user_id WHERE u.status IN ('active','awaiting_credential') AND c.status<>'removed'")
    names = [r['container_name'] for r in rows]
    previous_env = ENV.read_text()
    previous_compose = COMPOSE.read_bytes()
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    release = BASE/'releases'/f'{stamp}-{sha[:12]}'
    release.mkdir(parents=True, mode=0o700)
    os.chmod(release,0o700)
    shutil.copy2(ENV,release/'env.before')
    shutil.copy2(COMPOSE,release/'compose.before.yml')
    with (release/'database.sql').open('wb') as f:
        run(['docker','exec','station-db','sh','-c','pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"'],stdout=f)
    os.chmod(release/'database.sql',0o600)
    old_images = {name:output(['docker','inspect',name,'--format','{{.Image}}']) for name in names}
    replacement = {'STATION_PORTAL_IMAGE':manifest['images']['portal'], 'FDE_IMAGE':manifest['images']['runner'],
                   'STATION_DOCKER_PROXY_IMAGE':manifest['images']['proxy'], 'FDE_AGENT_VERSION':''}
    lines = previous_env.splitlines()
    lines = [line for line in lines if line.split('=',1)[0] not in replacement]
    lines.extend(f'{key}={value}' for key,value in replacement.items())
    changed = False
    try:
        run(['docker','stop','--time','45','station-portal'])
        changed = True
        ENV.write_text('\n'.join(lines)+'\n');os.chmod(ENV,0o600)
        COMPOSE.write_bytes((workspace/'deploy/docker-compose.yml').read_bytes())
        # Only additive migrations are permitted in this application's release contract.
        run([WRAPPER,'run','--rm','--no-deps','station-portal','node','portal/src/cli.js','migrate'])
        for name in names:
            if old_images[name] != manifest['images']['runner']:
                run(['docker','stop','--time','30',name]);run(['docker','rm',name])
        run([WRAPPER,'up','-d','--no-deps','station-docker-proxy','station-portal'])
        health(sha,names)
        # Verify the actual public ingress as well as the local portal listener.
        run(['curl','--fail','--silent','--show-error','--max-time','15','--resolve',
             'fs.5195746.xyz:443:127.0.0.1','https://fs.5195746.xyz/healthz'],stdout=subprocess.DEVNULL)
        (release/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
        (BASE/'current-release.json').write_text(json.dumps({'revision':sha,'directory':str(release),'images':manifest['images']},indent=2)+'\n')
        print('RELEASE_SUCCESS '+sha,flush=True)
    except Exception:
        if changed:
            print('Release failed; restoring previous application images/configuration',flush=True)
            subprocess.run(['docker','stop','--time','30','station-portal'],check=False)
            ENV.write_text(previous_env);os.chmod(ENV,0o600);COMPOSE.write_bytes(previous_compose)
            for name in names:
                inspect = subprocess.run(['docker','inspect',name,'--format','{{.Image}}'],text=True,capture_output=True)
                if inspect.returncode == 0 and inspect.stdout.strip()!=old_images[name]:
                    subprocess.run(['docker','stop','--time','30',name],check=False)
                    run(['docker','rm',name])
            run([WRAPPER,'up','-d','--no-deps','station-docker-proxy','station-portal'])
            health(None,names)
            print('ROLLBACK_HEALTHY',flush=True)
            # Keep additive schema and user data; DB restore is never automatic.
        raise


if __name__ == '__main__':
    main()
