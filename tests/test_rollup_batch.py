"""Bound source transactions and continue after a timeout without starving peers."""
from contextlib import contextmanager
from pathlib import Path
import sys
from types import SimpleNamespace

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'services'))
from pipeline.processor import refresh_rollup_batch
import pipeline.processor as processor


class FakeDB:
    def __init__(self,clock,slow=()):
        self.clock=clock;self.slow=set(slow);self.completed=[];self.transactions=[]
        self.pool=SimpleNamespace(connection=self.connection)

    def all(self,sql):return [{'source_id':i} for i in range(1,51)]

    @contextmanager
    def connection(self):
        commands=[];self.transactions.append(commands)
        def execute(sql,args=None):
            commands.append((sql,args))
            if args:
                assert commands[:3]==[("set local statement_timeout='5s'",None),("set local lock_timeout='1s'",None),("set local jit=off",None)]
                self.clock[0]+=.1
                if args[0] in self.slow:raise TimeoutError('Synthetic source timeout')
                self.completed.append(args[0])
        yield SimpleNamespace(execute=execute)


def test_fifty_sources_fit_one_tick_and_each_commits_separately(monkeypatch):
    clock=[100.];monkeypatch.setattr(processor.time,'monotonic',lambda:clock[0])
    db=FakeDB(clock)
    assert refresh_rollup_batch(db,{})==50
    assert len(db.transactions)==50 and len(db.completed)==50
    assert clock[0]<106


def test_timeout_defers_only_its_source_and_retries_after_backoff(monkeypatch):
    clock=[100.];monkeypatch.setattr(processor.time,'monotonic',lambda:clock[0])
    db=FakeDB(clock,slow=[1]);deferred={}
    assert refresh_rollup_batch(db,deferred)==49 and set(deferred)=={1}
    assert 1 not in db.completed and 50 in db.completed
    db.slow.clear();db.transactions.clear();db.completed.clear()
    assert refresh_rollup_batch(db,deferred)==49 and len(db.transactions)==49
    clock[0]=200
    assert refresh_rollup_batch(db,deferred)==50 and not deferred


def test_tick_budget_yields_between_source_transactions(monkeypatch):
    clock=[100.];monkeypatch.setattr(processor.time,'monotonic',lambda:clock[0])
    db=FakeDB(clock)
    completed=refresh_rollup_batch(db,{},budget_seconds=1)
    assert 9<=completed<=11 and completed==len(db.transactions)
