import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App as AntApp, Badge, Button, Card, Checkbox, Col, Descriptions, Empty, Form, Input, Layout, List, Menu, Row, Select, Space, Statistic, Table, Tag, Timeline, Typography, message } from 'antd';
import { ClockCircleOutlined, FlagOutlined, PlusOutlined, ReloadOutlined, SafetyCertificateOutlined, WarningOutlined } from '@ant-design/icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { addProtest, clearConflict, publishBatch, retryPublish, saveResult, setRaceStatus, store, transitionProtest, type AppDispatch, type RootState } from './store';
import { useGetOfficialsQuery } from './api';
import type { RaceEntry } from './types';

const { Header, Content, Sider } = Layout;

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

/**
 * 捕获实体在页面打开时的基线版本。
 * 跨标签页同步会更新 store，但不会刷新这里的基线，
 * 因此后到一方保存时会被版本校验拦截。
 */
function useBaseVersions<T extends { id: string; version: number }>(items: T[]) {
  const ref = useRef<Record<string, number>>({});
  const [, setTick] = useState(0);
  useEffect(() => {
    const map: Record<string, number> = {};
    items.forEach((item) => { map[item.id] = item.version; });
    ref.current = map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const refresh = () => {
    const map: Record<string, number> = {};
    items.forEach((item) => { map[item.id] = item.version; });
    ref.current = map;
    setTick((tick) => tick + 1);
  };
  return { versions: ref.current, refresh };
}

function VersionTag({ version }: { version: number }) {
  return <Tag color="blue">v{version}</Tag>;
}

/** 全局冲突提示：后到一方说明冲突并保留原文 */
function ConflictAlert() {
  const conflict = useSelector((state: RootState) => state.regatta.lastConflict);
  const dispatch = useDispatch<AppDispatch>();
  if (!conflict) return null;
  return (
    <Alert
      type="error"
      showIcon
      icon={<WarningOutlined />}
      style={{ marginBottom: 16 }}
      message="保存冲突，原文已保留"
      description={conflict.message}
      action={<Button size="small" onClick={() => dispatch(clearConflict())}>知道了</Button>}
    />
  );
}

/** 时间线上待重试的发布项 */
function PendingRetries() {
  const dispatch = useDispatch<AppDispatch>();
  const pending = useSelector((state: RootState) => state.regatta.timeline.filter((event) => event.pending && event.retryKind === 'publish'));
  if (pending.length === 0) return null;
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 16 }}
      message="待重试的发布项（已回滚，未生效）"
      description={
        <Space direction="vertical" style={{ width: '100%' }}>
          {pending.map((event) => (
            <div key={event.id}>
              <div>{event.message}</div>
              {event.reason && <small>原因：{event.reason}</small>}
              <div><Button size="small" type="primary" onClick={() => dispatch(retryPublish({ eventId: event.id }))}>重试发布</Button></div>
            </div>
          ))}
        </Space>
      }
    />
  );
}

function ControlPage() {
  const { t } = useTranslation();
  const dispatch = useDispatch<AppDispatch>();
  const race = useSelector((state: RootState) => state.regatta.races[0]);
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const sorted = useMemo(() => [...entries].sort((a, b) => a.elapsedSeconds + a.penaltySeconds - b.elapsedSeconds - b.penaltySeconds), [entries]);
  const invalidated = entries.filter((entry) => entry.resultStatus === 'corrected').length;

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <ConflictAlert />
      {invalidated > 0 && (
        <Alert type="warning" showIcon message={`正式成绩失效提示：抗议或处罚更新后，${invalidated} 项已发布成绩已失效，请重新发布。`} />
      )}
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={10}>
          <Card className="hero-card">
            <Badge status={race.status === 'running' ? 'processing' : 'success'} text={`比赛状态：${race.status}`} />
            <Statistic title="距离起航" value={countdown(race.startsAt, now)} prefix={<ClockCircleOutlined />} />
            <Descriptions column={1} style={{ marginTop: 18 }}>
              <Descriptions.Item label="组别">{race.fleet}</Descriptions.Item>
              <Descriptions.Item label="航线">{race.course}</Descriptions.Item>
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
              { title: '排名', render: (_v, _r, index) => index + 1, width: 64 },
              { title: '船名', dataIndex: 'boat' },
              { title: '帆号', dataIndex: 'sailNo' },
              { title: '船长', dataIndex: 'skipper' },
              { title: '净用时+处罚', render: (_v, r: RaceEntry) => `${r.elapsedSeconds + r.penaltySeconds}s` },
              { title: '版本', render: (_v, r: RaceEntry) => <VersionTag version={r.version} />, width: 76 },
              { title: '状态', render: (_v, r: RaceEntry) => <Tag color={r.resultStatus === 'official' ? 'green' : r.resultStatus === 'corrected' ? 'orange' : 'default'}>{r.resultStatus}</Tag> }
            ]} />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}

function ResultsPage() {
  const dispatch = useDispatch<AppDispatch>();
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const [api, contextHolder] = message.useMessage();
  const { versions: baseVersions, refresh: refreshBase } = useBaseVersions(entries);
  const [selected, setSelected] = useState<string[]>(entries.map((entry) => entry.id));
  const allChecked = selected.length === entries.length && entries.length > 0;

  const { register, handleSubmit, reset, watch, formState: { errors } } = useForm<z.infer<typeof resultSchema>>({
    resolver: zodResolver(resultSchema),
    defaultValues: { id: entries[0]?.id, elapsedSeconds: 3200, penaltySeconds: 0, note: '' }
  });
  const selectedEntryId = watch('id');
  const entryBaseVersion = baseVersions[selectedEntryId];

  const submit = (values: z.infer<typeof resultSchema>) => {
    const expected = baseVersions[values.id] ?? 1;
    dispatch(saveResult({ ...values, expectedVersion: expected }));
    const conflict = store.getState().regatta.lastConflict;
    if (conflict && conflict.entityType === 'entry' && conflict.entityId === values.id) {
      api.warning('保存冲突：原文已保留，请基于最新版本修改后重试');
      return;
    }
    api.success('成绩已更正并进入待发布状态');
    reset();
  };

  const toggleAll = () => {
    setSelected(allChecked ? [] : entries.map((entry) => entry.id));
  };
  const toggleOne = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const publish = () => {
    if (selected.length === 0) {
      api.warning('请至少选择一项成绩');
      return;
    }
    dispatch(publishBatch({ ids: selected, expectedVersions: baseVersions }));
    const conflict = store.getState().regatta.lastConflict;
    if (conflict) {
      api.warning('批量发布失败：已回滚上一版正式成绩，请刷新基线后重试');
    } else {
      api.success('正式成绩已批量发布');
    }
  };

  return (
    <>
      {contextHolder}
      <ConflictAlert />
      <PendingRetries />
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={10}>
          <Card title="成绩更正" extra={<VersionTag version={entryBaseVersion ?? 1} />}>
            <Form layout="vertical" onFinish={handleSubmit(submit)}>
              <Form.Item label="参赛船" validateStatus={errors.id ? 'error' : undefined} help={errors.id?.message}>
                <select {...register('id')} className="native-select">{entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.boat} / {entry.sailNo}</option>)}</select>
              </Form.Item>
              <Form.Item label="净用时（秒）"><Input type="number" {...register('elapsedSeconds', { valueAsNumber: true })} /></Form.Item>
              <Form.Item label="处罚秒数"><Input type="number" {...register('penaltySeconds', { valueAsNumber: true })} /></Form.Item>
              <Form.Item label="更正原因"><Input.TextArea rows={3} {...register('note')} /></Form.Item>
              <Space>
                <Button htmlType="submit" type="primary">保存更正</Button>
                <Button icon={<ReloadOutlined />} onClick={refreshBase}>刷新基线版本</Button>
              </Space>
            </Form>
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card title="批量发布正式成绩" extra={<Checkbox checked={allChecked} onChange={toggleAll}>全选</Checkbox>}>
            <List dataSource={entries} renderItem={(entry) => {
              const checked = selected.includes(entry.id);
              const stale = baseVersions[entry.id] !== undefined && baseVersions[entry.id] !== entry.version;
              return (
                <List.Item actions={[
                  <Checkbox key="pick" checked={checked} onChange={() => toggleOne(entry.id)} />,
                  <VersionTag key="v" version={entry.version} />
                ]}>
                  <List.Item.Meta
                    title={<Space>{entry.boat} · {entry.elapsedSeconds + entry.penaltySeconds} 秒{stale && <Tag color="red">基线 v{baseVersions[entry.id]} 已过期</Tag>}</Space>}
                    description={entry.note || '无更正说明'}
                  />
                  <Tag color={entry.resultStatus === 'official' ? 'green' : 'orange'}>{entry.resultStatus}</Tag>
                </List.Item>
              );
            }} />
            <Space style={{ marginTop: 12 }}>
              <Button type="primary" onClick={publish}>发布所选正式成绩</Button>
              <Button icon={<ReloadOutlined />} onClick={refreshBase}>刷新基线版本</Button>
            </Space>
          </Card>
        </Col>
      </Row>
    </>
  );
}

function ProtestsPage() {
  const dispatch = useDispatch<AppDispatch>();
  const protests = useSelector((state: RootState) => state.regatta.protests);
  const timeline = useSelector((state: RootState) => state.regatta.timeline);
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const [api, contextHolder] = message.useMessage();
  const { versions: baseVersions, refresh: refreshBase } = useBaseVersions(protests);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof protestSchema>>({ resolver: zodResolver(protestSchema), defaultValues: { entryId: entries[0]?.id, reason: '', rule: 'RRS 14' } });

  const submit = (values: z.infer<typeof protestSchema>) => {
    dispatch(addProtest({ raceId: 'race-1', ...values }));
    reset({ entryId: entries[0]?.id, reason: '', rule: 'RRS 14' });
  };

  const transition = (id: string, status: 'reviewing' | 'resolved' | 'rejected', decision?: string, penaltySeconds?: number) => {
    const expected = baseVersions[id] ?? 1;
    dispatch(transitionProtest({ id, status, decision, penaltySeconds, expectedVersion: expected }));
    const conflict = store.getState().regatta.lastConflict;
    if (conflict && conflict.entityType === 'protest' && conflict.entityId === id) {
      api.warning('抗议处理冲突：原文已保留，请刷新后再处理');
    }
  };

  return (
    <Row gutter={[18, 18]}>
      {contextHolder}
      <Col xs={24} lg={9}>
        <ConflictAlert />
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
        <Card title="冲突复核队列" extra={<Button size="small" icon={<ReloadOutlined />} onClick={refreshBase}>刷新基线</Button>}>
          {protests.length === 0 ? <Empty /> : <List dataSource={protests} renderItem={(item) => {
            const stale = baseVersions[item.id] !== undefined && baseVersions[item.id] !== item.version;
            return (
              <List.Item>
                <List.Item.Meta
                  title={<Space><Tag color={item.status === 'reviewing' ? 'processing' : 'default'}>{item.status}</Tag>{item.rule}<VersionTag version={item.version} />{stale && <Tag color="red">基线 v{baseVersions[item.id]} 已过期</Tag>}</Space>}
                  description={<><div>{item.reason}</div><small>{entries.find((entry) => entry.id === item.entryId)?.boat}</small>{item.decision && <div>结论：{item.decision}</div>}</>}
                />
                <Space direction="vertical">
                  <Button size="small" onClick={() => transition(item.id, 'reviewing')}>进入复核</Button>
                  <Button size="small" type="primary" onClick={() => transition(item.id, 'resolved', '接受抗议并处以30秒处罚', 30)}>接受并处罚</Button>
                  <Button size="small" danger onClick={() => transition(item.id, 'rejected', '证据不足，维持原成绩')}>驳回</Button>
                </Space>
              </List.Item>
            );
          }} />}
        </Card>
      </Col>
      <Col xs={24} lg={6}>
        <Card title="事件时间线"><Timeline items={timeline.map((event) => ({ color: event.type === 'protest' ? 'orange' : event.type === 'conflict' ? 'red' : event.type === 'publish' ? 'green' : 'blue', children: <><b>{event.type}</b>{event.pending && <Tag color="gold" style={{ marginLeft: 6 }}>待重试</Tag>}<div>{event.message}</div>{event.reason && <small>原因：{event.reason}</small>}<small>{new Date(event.time).toLocaleTimeString()}</small></> }))} /></Card>
      </Col>
    </Row>
  );
}

function Shell() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { data = [] } = useGetOfficialsQuery();
  return (
    <AntApp>
      <Layout className="shell">
        <Header className="header">
          <Space><SafetyCertificateOutlined style={{ fontSize: 24 }} /><Typography.Title level={4} style={{ margin: 0, color: 'white' }}>{t('title')}</Typography.Title></Space>
          <Space><Tag>{data.length} 名值班人员</Tag><Button ghost onClick={() => void i18n.changeLanguage(i18n.language.startsWith('zh') ? 'en' : 'zh')}>{t('language')}</Button></Space>
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
            <Route path="/results" element={<ResultsPage />} />
            <Route path="/protests" element={<ProtestsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes></Content>
        </Layout>
      </Layout>
    </AntApp>
  );
}

export default function App() { return <BrowserRouter><Shell /></BrowserRouter>; }
