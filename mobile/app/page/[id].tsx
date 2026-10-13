import { ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Blocks } from '../../src/Blocks';
import { useStore } from '../../src/store';
import { space, usePalette } from '../../src/theme';
import { Ambient, T, TopBar } from '../../src/ui';

export default function PageScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const page = useStore().lib?.pages?.find((x) => x.id === id);
  return (
    <View style={{ flex: 1, backgroundColor: p.ground }}>
      <Ambient height={260} />
      <ScrollView contentContainerStyle={{ paddingTop: insets.top, paddingBottom: insets.bottom + space.xxl }}>
        <TopBar back title={page?.name ?? 'Page'} />
        {page ? <Blocks blocks={page.blocks} /> : <T v="body" c={p.ink2} style={{ padding: space.l }}>This page was removed on your computer.</T>}
      </ScrollView>
    </View>
  );
}
