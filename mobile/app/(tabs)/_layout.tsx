import { Tabs } from 'expo-router';
import { TabBar } from '../../src/TabBar';

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false, animation: 'shift' }} tabBar={(props) => <TabBar {...props} />}>
      <Tabs.Screen name="index" options={{ title: 'Feed' }} />
      <Tabs.Screen name="today" options={{ title: 'Today' }} />
      <Tabs.Screen name="agent" options={{ title: 'Agent' }} />
      <Tabs.Screen name="sources" options={{ title: 'Sources' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
    </Tabs>
  );
}
