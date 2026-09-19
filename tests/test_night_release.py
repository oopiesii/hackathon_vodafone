"""Release/rollback simulations: no Docker call, network request or production write."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

SPEC=importlib.util.spec_from_file_location('night_release',Path(__file__).resolve().parents[1]/'deploy/night-release.py')
release=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


def state(image='sha256:previous',running=True,started='2026-09-19T20:00:00Z',health='healthy'):
    return {'image':image,'running':running,'started_at':started,'health':health}


@pytest.fixture
def simulation(monkeypatch,tmp_path):
    machines={};commands=[]
    monkeypatch.setattr(release,'STATE',tmp_path)
    monkeypatch.setattr(release,'container_state',lambda name:machines.get(name))
    monkeypatch.setattr(release.time,'sleep',lambda _:None)
    monkeypatch.setattr(release,'verify_services',lambda images:None)
    def run(args,**kwargs):
        commands.append(args)
        if 'rm' in args:
            for name in list(machines):
                if name in args:machines.pop(name)
        if 'stop' in args and 'rm' not in args:
            for name in machines:
                if name in args:machines[name]['running']=False
    monkeypatch.setattr(release,'run',run)
    def switch(images,stamp,start=True):
        commands.append(['switch',images,start])
        for name,image in images.items():machines[name]=state(image,running=start)
    monkeypatch.setattr(release,'switch',switch)
    import httpx
    monkeypatch.setattr(httpx,'get',lambda *a,**kw:SimpleNamespace(status_code=200))
    return machines,commands,tmp_path


def manifest(services):
    return {'stamp':'night-simulation','status':'switching','services':services,'untouched':{}}


def test_first_analyst_rollback_restores_absence_not_a_stopped_failed_image(simulation):
    machines,commands,tmp=simulation
    machines['analyst']=state('sha256:failed',health='unhealthy')
    data=manifest({'analyst':{'before':None,'before_state':None,'rollback':None,'candidate':'ufv-analyst:new'}})
    release.rollback(data,tmp/'manifest.json')
    assert 'analyst' not in machines
    assert any('rm' in command and '--stop' in command and command[-1]=='analyst' for command in commands)
    assert not any(command[0]=='switch' for command in commands)
    assert data['status']=='rolled_back'
    assert release.running('analyst') is None


def test_rollback_preserves_previously_stopped_service(simulation):
    machines,commands,tmp=simulation
    machines['analyst']=state('sha256:candidate')
    data=manifest({'analyst':{'before':'sha256:old','before_state':state('sha256:old',running=False),
                              'rollback':'ufv-analyst:old','candidate':'ufv-analyst:new'}})
    release.rollback(data,tmp/'manifest.json')
    assert not machines['analyst']['running']
    assert [c[2] for c in commands if c[0]=='switch']==[False]
    assert release.running('analyst') is None


def test_neighbor_failure_marks_rollback_failed_not_rolled_back(simulation,monkeypatch):
    _,_,tmp=simulation
    import httpx
    monkeypatch.setattr(httpx,'get',lambda url,**kw:SimpleNamespace(status_code=500 if 'h1hs.com' in url else 200))
    data=manifest({})
    with pytest.raises(RuntimeError,match='neighbor_failed_after_rollback'):
        release.rollback(data,tmp/'manifest.json')
    assert data['status']=='rollback_failed'
    assert json.loads((tmp/'manifest.json').read_text())['status']=='rollback_failed'


def test_manual_rollback_preserves_a_later_unrelated_service_release(simulation):
    machines,commands,tmp=simulation
    machines['processor']=state('sha256:newer-independent-processor')
    data=manifest({})
    data['untouched']={'processor':state('sha256:processor-at-old-release')}
    release.rollback(data,tmp/'manifest.json')
    assert machines['processor']['image']=='sha256:newer-independent-processor'
    assert data['status']=='rolled_back'


def test_selected_worker_must_be_ready_even_when_api_is_healthy(monkeypatch):
    monkeypatch.setattr(release,'capture',lambda _: 'sha256:candidate')
    monkeypatch.setattr(release.time,'sleep',lambda _:None)
    monkeypatch.setattr(release,'container_state',lambda _:state('sha256:candidate',running=False,health='unhealthy'))
    with pytest.raises(RuntimeError,match='selected_services_not_ready'):
        release.verify_services({'analyst':'ufv-analyst:candidate'})
    monkeypatch.setattr(release,'container_state',lambda _:state('sha256:candidate',health='healthy'))
    monkeypatch.setattr(release,'worker_ready',lambda *args:False)
    with pytest.raises(RuntimeError,match='selected_services_not_ready'):
        release.verify_services({'analyst':'ufv-analyst:candidate'})
    monkeypatch.setattr(release,'worker_ready',lambda *args:True)
    release.verify_services({'analyst':'ufv-analyst:candidate'})


def test_unrequested_restart_is_detected(monkeypatch):
    monkeypatch.setattr(release,'container_state',lambda _:state(started='2026-09-19T21:00:00Z'))
    with pytest.raises(RuntimeError,match='unrequested_service_changed_collector'):
        release.verify_untouched({'collector':state()})


def test_switch_is_explicitly_scoped_and_never_starts_dependencies(monkeypatch,tmp_path):
    commands=[]
    monkeypatch.setattr(release,'STATE',tmp_path)
    monkeypatch.setattr(release,'run',lambda args:commands.append(args))
    release.switch({'analyst':'ufv-analyst:candidate'},'simulation')
    release.switch({'analyst':'ufv-analyst:old'},'simulation-stopped',start=False)
    assert all('--no-deps' in command and '--no-build' in command for command in commands)
    assert commands[0][-1]=='analyst' and 'up' in commands[0]
    assert commands[1][-1]=='analyst' and 'create' in commands[1] and 'up' not in commands[1]


def test_worker_probe_contains_no_dsn_and_generated_python_is_valid(monkeypatch):
    commands=[]
    def execute(args,**kw):
        commands.append(args)
        compile(args[5],'<worker-probe>','exec')
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(release.subprocess,'run',execute)
    assert release.worker_ready('analyst','2026-09-19T20:00:00Z')
    assert commands[0][:5]==['docker','exec','ufv-analyst-1','python','-c']
    assert 'postgres://' not in ' '.join(commands[0])
