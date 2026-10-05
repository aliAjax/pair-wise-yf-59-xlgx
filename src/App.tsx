import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, Alert, Badge, Button, Card, Checkbox, Col, Descriptions, Empty, Form, Input, Layout, List, Menu, Modal, Row, Select, Space, Statistic, Table, Tag, Timeline, Typography, message } from 'antd';
import { ClockCircleOutlined, FlagOutlined, PlusOutlined, RedoOutlined, SafetyCertificateOutlined, WarningOutlined } from '@ant-design/icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import {
  addProtest, publishBatch, retryPending, saveResultThunk, setRaceStatus, transitionProtestThunk,
  resolveConflict, type AppDispatch, type RootState
} from './store';
import type { Official } from './api';
import { useGetOfficialsQuery } from './api';
import type { RaceEntry, ResultConflict } from './types';

const { Header, Content, Sider } = Layout;
const ACTOR_KEY = 'regatta-active-official';

const resultSchema = z.object({
  id: z.string().min(1),
  elapsedSeconds: z.number().positive(),
  penaltySeconds: z.number().min(0),
  note: z.string().max(120)
});
const protestSchema = z.object({
  entryId: z.string().min(1),
  reason: z.string().min(4),
  rule: z.string().min(2)
});

function countdown(target: string, now: number) {
  const seconds = Math.max(0, Math.floor((new Date(target).getTime() - now) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function statusTag(status: RaceEntry['resultStatus']) {
  if (status === 'official') return <Tag color="green">已发布 official</Tag>;
  if (status === 'corrected') return <Tag color="orange">更正待发布 corrected</Tag>;
  if (status === 'invalidated') return <Tag color="red" icon={<WarningOutlined />}>名次失效 invalidated</Tag>;
  return <Tag>临时 provisional</Tag>;
}

function useActor() {
  const { data } = useGetOfficialsQuery();
  const officials = data ?? [];
  const [actorId, setActorId] = useState(() => localStorage.getItem(ACTOR_KEY) ?? 'o3');
  const actor = officials.find((item) => item.id === actorId) ?? officials[0] ?? { id: 'o3', name: '罗夏', role: '计时员' };
  useEffect(() => { localStorage.setItem(ACTOR_KEY, actorId); }, [actorId]);
  return { actor, actorId, setActorId, officials };
}

function useActiveRaceId() {
  return useSelector((state: RootState) => state.regatta.races[0]?.id ?? 'race-1');
}

function ConflictPanel({ conflicts, scope, actor }: { conflicts: ResultConflict[]; scope: 'result' | 'protest'; actor: string }) {
  const dispatch = useDispatch<AppDispatch>();
  const mine = conflicts.filter((item) => item.kind === scope);
  if (mine.length === 0) return null;
  return (
    <Card size="small" style={{ borderColor: '#ffa39e' }} title={<Space><WarningOutlined style={{ color: '#cf1322' }} />版本冲突（{mine.length}）—— 你的原文已保留，未覆盖对方结果</Space>}>
      <List size="small" dataSource={mine} renderItem={(conflict) => (
        <List.Item actions={[
          <Button key="discard" size="small" onClick={() => dispatch(resolveConflict({ id: conflict.id }))}>放弃我的修改</Button>
        ]}>
          <List.Item.Meta
            title={<Space>{conflict.boat} <Tag color="red">v{conflict.baseVersion} → v{conflict.currentVersion}</Tag><Tag>{conflict.fieldLabels.join('、')}</Tag></Space>}
            description={
              <Space direction="vertical" size={2}>
                <span>{conflict.detail}，操作人 {actor}</span>
                <span>原文（你打开时）：净用时 {conflict.baseValues.elapsedSeconds}s / 处罚 {conflict.baseValues.penaltySeconds}s · {conflict.baseValues.note || '无说明'}</span>
                <span style={{ color: '#cf1322' }}>对方现值：净用时 {conflict.currentValues.elapsedSeconds}s / 处罚 {conflict.currentValues.penaltySeconds}s · {conflict.currentValues.note || '无说明'}</span>
                <span>你的输入（保留）：净用时 {conflict.attemptedValues.elapsedSeconds}s / 处罚 {conflict.attemptedValues.penaltySeconds}s · {conflict.attemptedValues.note || '无说明'}</span>
                <ForceOverwrite conflict={conflict} />
              </Space>
            }
          />
        </List.Item>
      )} />
    </Card>
  );
}

function ForceOverwrite({ conflict }: { conflict: ResultConflict }) {
  const dispatch = useDispatch<AppDispatch>();
  const [open, setOpen] = useState(false);
  const confirm = () => {
    if (conflict.kind === 'result') {
      dispatch(saveResultThunk({
        id: conflict.entryId,
        elapsedSeconds: conflict.attemptedValues.elapsedSeconds,
        penaltySeconds: conflict.attemptedValues.penaltySeconds,
        note: conflict.attemptedValues.note,
        base: conflict.baseValues,
        baseVersion: conflict.currentVersion,
        actor: `${conflict.actor}（强制覆盖）`,
        force: true
      }));
    } else {
      const m = conflict.attemptedValues.note.match(/^(resolved|rejected)：(.*)$/);
      dispatch(transitionProtestThunk({
        id: conflict.documentId,
        status: (m?.[1] as 'resolved' | 'rejected') ?? 'resolved',
        decision: m?.[2] ?? conflict.attemptedValues.note,
        penaltySeconds: conflict.attemptedValues.penaltySeconds,
        baseVersion: conflict.currentVersion,
        actor: `${conflict.actor}（强制覆盖）`,
        force: true
      }));
    }
    dispatch(resolveConflict({ id: conflict.id }));
    setOpen(false);
  };
  return (
    <>
      <Button size="small" danger type="link" onClick={() => setOpen(true)}>仍以我的输入强制覆盖（将生成新版本）</Button>
      <Modal open={open} title="确认强制覆盖" onOk={confirm} onCancel={() => setOpen(false)} okText="确认覆盖" cancelText="取消" okButtonProps={{ danger: true }}>
        对方的 v{conflict.currentVersion} 会被你的输入覆盖为 v{conflict.currentVersion + 1}，覆盖动作会写入事件时间线。是否继续？
      </Modal>
    </>
  );
}

function ControlPage() {
  const { t } = useTranslation();
  const dispatch = useDispatch<AppDispatch>();
  const race = useSelector((state: RootState) => state.regatta.races[0]);
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const snapshots = useSelector((state: RootState) => state.regatta.officialSnapshots);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const sorted = useMemo(() => [...entries].sort((a, b) => a.elapsedSeconds + a.penaltySeconds - b.elapsedSeconds - b.penaltySeconds), [entries]);
  const invalidCount = entries.filter((entry) => entry.resultStatus === 'invalidated').length;
  const latest = snapshots[snapshots.length - 1];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      {invalidCount > 0 && (
        <Alert type="error" showIcon icon={<WarningOutlined />}
          message={`抗议结论/处罚更新后，${invalidCount} 艘船的已发布名次失效，需竞赛官在“成绩管理”重算并重新整批发布`} />
      )}
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={10}>
          <Card className="hero-card">
            <Badge status={race.status === 'running' ? 'processing' : 'success'} text={`比赛状态：${race.status}`} />
            <Statistic title="距离起航" value={countdown(race.startsAt, now)} prefix={<ClockCircleOutlined />} />
            <Descriptions column={1} style={{ marginTop: 18 }}>
              <Descriptions.Item label="组别">{race.fleet}</Descriptions.Item>
              <Descriptions.Item label="航线">{race.course}</Descriptions.Item>
              <Descriptions.Item label="当前正式名次">
                {latest ? `${latest.ranking.length} 个名次 · ${latest.publishedBy} · ${new Date(latest.publishedAt).toLocaleTimeString()}` : '尚无已发布版本'}
              </Descriptions.Item>
            </Descriptions>
            <Space wrap>
              <Button type="primary" icon={<FlagOutlined />} onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'running' }))}>开始比赛</Button>
              <Button onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'finished' }))}>结束比赛</Button>
              <Button onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'scheduled' }))}>重置排队</Button>
            </Space>
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card title={t('control')} extra={<Tag color="blue">{sorted.length} 艘参赛船</Tag>}>
            <Table rowKey="id" pagination={false} dataSource={sorted} columns={[
              { title: '临时排名', render: (_v, _r, index) => index + 1, width: 80 },
              { title: '船名', dataIndex: 'boat' },
              { title: '帆号', dataIndex: 'sailNo' },
              { title: '船长', dataIndex: 'skipper' },
              { title: '当前净用时', render: (_v, r: RaceEntry) => `${r.elapsedSeconds + r.penaltySeconds}s` },
              { title: '版本', render: (_v, r: RaceEntry) => <Tag>v{r.version}</Tag>, width: 72 },
              { title: '状态', render: (_v, r: RaceEntry) => statusTag(r.resultStatus) }
            ]} />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}

type ResultForm = z.infer<typeof resultSchema>;

function ResultsPage({ actor }: { actor: Official }) {
  const dispatch = useDispatch<AppDispatch>();
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const pending = useSelector((state: RootState) => state.regatta.pendingPublishes);
  const conflicts = useSelector((state: RootState) => state.regatta.conflicts);
  const snapshots = useSelector((state: RootState) => state.regatta.officialSnapshots);
  const raceId = useActiveRaceId();
  const [api, contextHolder] = message.useMessage();
  const [formMeta, setFormMeta] = useState<{ version: number; base: ResultForm } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [failAt, setFailAt] = useState(2); // 模拟“发布中途失败”：在第几项失败，-1 为不失败
  const [failReason, setFailReason] = useState('成绩板网络中断');

  const first = entries[0];
  const { register, handleSubmit, reset, watch, formState: { errors } } = useForm<ResultForm>({
    resolver: zodResolver(resultSchema),
    defaultValues: { id: first?.id, elapsedSeconds: first?.elapsedSeconds ?? 3200, penaltySeconds: first?.penaltySeconds ?? 0, note: first?.note ?? '' }
  });
  const selectedId = watch('id') ?? first?.id;
  const selectedEntry = entries.find((entry) => entry.id === selectedId);

  const loadEntry = (id: string) => {
    const entry = entries.find((item) => item.id === id);
    if (!entry) return;
    const values = { id: entry.id, elapsedSeconds: entry.elapsedSeconds, penaltySeconds: entry.penaltySeconds, note: entry.note };
    reset(values);
    setFormMeta({ version: entry.version, base: values });
  };

  // 参赛船切换或对方在另一标签页保存后，提示表单基线已落后
  useEffect(() => {
    if (!selectedEntry) return;
    setFormMeta((prev) => {
      if (!prev || prev.base.id !== selectedEntry.id) {
        return {
          version: selectedEntry.version,
          base: { id: selectedEntry.id, elapsedSeconds: selectedEntry.elapsedSeconds, penaltySeconds: selectedEntry.penaltySeconds, note: selectedEntry.note }
        };
      }
      return prev;
    });
  }, [selectedEntry?.id, selectedEntry?.version]);

  const actorName = `${actor.name}（${actor.role}）`;
  const submit = (values: ResultForm) => {
    const outcome = dispatch(saveResultThunk({
      id: values.id,
      elapsedSeconds: values.elapsedSeconds,
      penaltySeconds: values.penaltySeconds,
      note: values.note,
      base: formMeta?.base ?? { id: values.id, elapsedSeconds: values.elapsedSeconds, penaltySeconds: values.penaltySeconds, note: values.note },
      baseVersion: formMeta?.version ?? selectedEntry?.version ?? 1,
      actor: actorName
    }));
    if (outcome.ok) {
      api.success(`已保存为 v${outcome.version}${outcome.invalidated ? '；已发布名次因此失效，需重算重发' : '，进入待发布状态'}`);
      // 以刚提交的值作为新基线，便于继续编辑；服务端版本已前进
      if (selectedEntry) setFormMeta({ version: outcome.version, base: { ...values } });
    } else {
      api.error('保存被版本校验拦截：另一标签页已先保存，你的输入已保留在下方冲突区');
    }
  };

  const publishable = entries.filter((entry) => selected.includes(entry.id));
  const doPublish = (ids: string[], isRetry: boolean) => {
    const index = Math.min(failAt, ids.length - 1);
    if (isRetry) {
      dispatch(retryPending({ ids, actor: actorName, failAtIndex: index, reason: failReason }));
    } else {
      dispatch(publishBatch({ ids, actor: actorName, failAtIndex: index, reason: failReason }));
    }
  };

  const pendingGroups = useMemo(() => {
    const map = new Map<string, { batchId: string; reason: string; items: typeof pending; time: string }>();
    for (const item of pending) {
      const group = map.get(item.batchId) ?? { batchId: item.batchId, reason: item.reason, items: [], time: item.failedAt };
      group.items.push(item);
      map.set(item.batchId, group);
    }
    return Array.from(map.values());
  }, [pending]);
  const latestSnapshot = snapshots[snapshots.length - 1];

  return (
    <>
      {contextHolder}
      <Space direction="vertical" size={18} style={{ width: '100%' }}>
        <ConflictPanel conflicts={conflicts} scope="result" actor={actorName} />
        <Row gutter={[18, 18]}>
          <Col xs={24} lg={10}>
            <Card title="成绩更正（乐观锁）" extra={selectedEntry ? <Tag>基线 v{formMeta?.version ?? selectedEntry.version}</Tag> : null}>
              <Form layout="vertical" onFinish={handleSubmit(submit)}>
                <Form.Item label="参赛船" validateStatus={errors.id ? 'error' : undefined} help={errors.id?.message}>
                  <select {...register('id', { onChange: (event) => loadEntry(event.target.value) })} className="native-select">
                    {entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.boat} / {entry.sailNo}（v{entry.version}）</option>)}
                  </select>
                </Form.Item>
                <Form.Item label="净用时（秒）"><Input type="number" {...register('elapsedSeconds', { valueAsNumber: true })} /></Form.Item>
                <Form.Item label="处罚秒数"><Input type="number" {...register('penaltySeconds', { valueAsNumber: true })} /></Form.Item>
                <Form.Item label="更正原因" validateStatus={errors.note ? 'error' : undefined} help={errors.note?.message}><Input.TextArea rows={3} {...register('note')} /></Form.Item>
                <Space>
                  <Button htmlType="submit" type="primary">保存更正（带版本校验）</Button>
                  <Button onClick={() => loadEntry(watch('id'))} icon={<RedoOutlined />}>重读最新版本</Button>
                </Space>
                {selectedEntry && <Alert style={{ marginTop: 12 }} type="info" showIcon message={`当前服务端版本 v${selectedEntry.version}：${selectedEntry.elapsedSeconds}s + ${selectedEntry.penaltySeconds}s${formMeta && formMeta.version !== selectedEntry.version ? '，与你打开表单时的版本不同，直接保存会收到冲突提示' : ''}`} />}
              </Form>
            </Card>
          </Col>
          <Col xs={24} lg={14}>
            <Card
              title="整批发布正式成绩"
              extra={<Space>
                <span>模拟失败于第</span>
                <Input type="number" min={-1} style={{ width: 64 }} value={failAt} onChange={(event) => setFailAt(Number(event.target.value))} />
                <span>项（-1=全部成功）</span>
              </Space>}>
              <Space style={{ marginBottom: 12 }}>
                <Input style={{ width: 220 }} value={failReason} onChange={(event) => setFailReason(event.target.value)} addonBefore="失败原因" />
                <Button type="primary" disabled={publishable.length === 0} onClick={() => doPublish(publishable.map((entry) => entry.id), false)}>
                  整批发布（{publishable.length} 项，原子提交）
                </Button>
              </Space>
              {latestSnapshot && <Alert style={{ marginBottom: 12 }} type="success" showIcon message={`上一版正式成绩：${latestSnapshot.publishedBy} 发布，${latestSnapshot.ranking.length} 个名次（${latestSnapshot.ranking.map((item) => `#${item.rank} ${item.boat}`).join('、') || '空榜'}）；中途失败时自动恢复此版本`} />}
              <List dataSource={entries} renderItem={(entry) => (
                <List.Item actions={[
                  <Checkbox key="check" checked={selected.includes(entry.id)} onChange={(event) => setSelected((prev) => event.target.checked ? [...prev, entry.id] : prev.filter((id) => id !== entry.id))}>纳入批次</Checkbox>
                ]}>
                  <List.Item.Meta
                    title={<Space>{entry.boat} · {entry.elapsedSeconds + entry.penaltySeconds} 秒 <Tag>v{entry.version}</Tag>{statusTag(entry.resultStatus)}</Space>}
                    description={entry.note || '无更正说明'}
                  />
                </List.Item>
              )} />
            </Card>
          </Col>
        </Row>
        {pendingGroups.length > 0 && (
          <Card title="待重试队列（失败项与原因已写入事件时间线）" style={{ borderColor: '#ffbb96' }}>
            <List dataSource={pendingGroups} renderItem={(group) => {
              const ids = group.items.map((item) => item.entryId);
              return (
                <List.Item actions={[
                  <Button key="retry" type="primary" icon={<RedoOutlined />} onClick={() => doPublish(ids, true)}>重试该组（{ids.length} 项）</Button>
                ]}>
                  <List.Item.Meta
                    title={<Space><Tag color="volcano">批次 {group.batchId.slice(0, 8)}</Tag><WarningOutlined style={{ color: '#d4380d' }} />{group.reason}</Space>}
                    description={group.items.map((item) => `${item.boat} ${item.totalSeconds}s（已尝试 ${item.attempts} 次）`).join('；')}
                  />
                </List.Item>
              );
            }} />
          </Card>
        )}
      </Space>
    </>
  );
}

type ProtestForm = z.infer<typeof protestSchema>;

function ProtestsPage({ actor }: { actor: Official }) {
  const dispatch = useDispatch<AppDispatch>();
  const protests = useSelector((state: RootState) => state.regatta.protests);
  const timeline = useSelector((state: RootState) => state.regatta.timeline);
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const conflicts = useSelector((state: RootState) => state.regatta.conflicts);
  const [api, contextHolder] = message.useMessage();
  const { register, handleSubmit, reset, formState: { errors } } = useForm<ProtestForm>({ resolver: zodResolver(protestSchema), defaultValues: { entryId: entries[0]?.id, reason: '', rule: 'RRS 14' } });
  const actorName = `${actor.name}（${actor.role}）`;
  const raceId = useActiveRaceId();
  const submit = (values: ProtestForm) => {
    dispatch(addProtest({ raceId, ...values }));
    api.success('抗议已登记（v1）');
    reset({ entryId: entries[0]?.id, reason: '', rule: 'RRS 14' });
  };

  const act = (id: string, status: 'reviewing' | 'resolved' | 'rejected', decision?: string, penaltySeconds?: number) => {
    const protest = protests.find((item) => item.id === id);
    const outcome = dispatch(transitionProtestThunk({
      id, status, decision, penaltySeconds,
      baseVersion: protest?.version ?? 1,
      actor: actorName
    }));
    if (outcome.ok) api.success(`抗议结论已更新到 v${outcome.version}${status === 'reviewing' ? '' : '；如影响处罚，已发布名次将失效重算'}`);
    else api.error('抗议结论被版本校验拦截：另一标签页已先给出结论，原文已保留');
  };

  return (
    <>
      {contextHolder}
      <Space direction="vertical" size={18} style={{ width: '100%' }}>
        <ConflictPanel conflicts={conflicts} scope="protest" actor={actorName} />
        <Row gutter={[18, 18]}>
          <Col xs={24} lg={9}>
            <Card title="提交抗议">
              <Form layout="vertical" onFinish={handleSubmit(submit)}>
                <Form.Item label="参赛船" validateStatus={errors.entryId ? 'error' : undefined}>
                  <select className="native-select" {...register('entryId')}>{entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.boat}</option>)}</select>
                </Form.Item>
                <Form.Item label="适用规则" validateStatus={errors.rule ? 'error' : undefined} help={errors.rule?.message}><Input {...register('rule')} /></Form.Item>
                <Form.Item label="事件描述" validateStatus={errors.reason ? 'error' : undefined} help={errors.reason?.message}><Input.TextArea rows={4} {...register('reason')} /></Form.Item>
                <Button type="primary" htmlType="submit" icon={<PlusOutlined />}>登记抗议</Button>
              </Form>
            </Card>
          </Col>
          <Col xs={24} lg={9}>
            <Card title="冲突复核队列">
              {protests.length === 0 ? <Empty /> : <List dataSource={protests} renderItem={(item) => (
                <List.Item>
                  <List.Item.Meta
                    title={<Space><Tag color={item.status === 'reviewing' ? 'processing' : item.status === 'resolved' ? 'success' : item.status === 'rejected' ? 'error' : 'default'}>{item.status}</Tag>{item.rule}<Tag>v{item.version}</Tag></Space>}
                    description={<><div>{item.reason}</div><div>{item.decision && <b>结论：{item.decision}</b>}</div><small>{entries.find((entry) => entry.id === item.entryId)?.boat}</small></>}
                  />
                  <Space direction="vertical">
                    <Button size="small" onClick={() => act(item.id, 'reviewing')}>进入复核</Button>
                    <Button size="small" type="primary" onClick={() => act(item.id, 'resolved', '接受抗议并处以30秒处罚', 30)}>接受并处罚</Button>
                    <Button size="small" danger onClick={() => act(item.id, 'rejected', '证据不足，维持原成绩')}>驳回</Button>
                  </Space>
                </List.Item>
              )} />}
            </Card>
          </Col>
          <Col xs={24} lg={6}>
            <Card title="事件时间线">
              <Timeline items={timeline.slice(0, 40).map((event) => ({
                color: event.type === 'protest' ? 'orange' : event.type === 'system' ? 'red' : event.message.includes('发布') ? 'green' : 'blue',
                children: <><b>{event.type}</b><div>{event.message}</div><small>{new Date(event.time).toLocaleTimeString()}</small></>
              }))} />
            </Card>
          </Col>
        </Row>
      </Space>
    </>
  );
}

function Shell() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { actor, actorId, setActorId, officials } = useActor();
  return (
    <AntApp>
      <Layout className="shell">
      <Header className="header">
        <Space><SafetyCertificateOutlined style={{ fontSize: 24 }} /><Typography.Title level={4} style={{ margin: 0, color: 'white' }}>{t('title')}</Typography.Title></Space>
        <Space>
          <span style={{ color: 'rgba(255,255,255,0.75)' }}>当前操作人（模拟标签页身份）</span>
          <Select size="small" style={{ width: 190 }} value={actorId} onChange={setActorId}
            options={officials.map((item: Official) => ({ value: item.id, label: `${item.name} · ${item.role}` }))} />
          <Tag>{officials.length} 名值班人员</Tag>
          <Button ghost onClick={() => void i18n.changeLanguage(i18n.language.startsWith('zh') ? 'en' : 'zh')}>{t('language')}</Button>
        </Space>
      </Header>
      <Layout>
        <Sider width={210} breakpoint="lg" collapsedWidth="0" theme="light">
          <Menu mode="inline" selectedKeys={[location.pathname]} onClick={({ key }) => navigate(key)} items={[
            { key: '/', label: t('control'), icon: <FlagOutlined /> },
            { key: '/results', label: t('results'), icon: <ClockCircleOutlined /> },
            { key: '/protests', label: t('protests'), icon: <SafetyCertificateOutlined /> }
          ]} />
        </Sider>
        <Content className="content"><Routes>
          <Route path="/" element={<ControlPage />} />
          <Route path="/results" element={<ResultsPage actor={actor} />} />
          <Route path="/protests" element={<ProtestsPage actor={actor} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes></Content>
      </Layout>
      </Layout>
    </AntApp>
  );
}

export default function App() { return <BrowserRouter><Shell /></BrowserRouter>; }
