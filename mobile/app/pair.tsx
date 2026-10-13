// aurora://pair links land here when the phone is already paired: go to the feed.
import { Redirect } from 'expo-router';

export default function AlreadyPaired() {
  return <Redirect href="/" />;
}
