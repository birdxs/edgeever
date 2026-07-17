import "react-native-gesture-handler";

import AsyncStorage from "@react-native-async-storage/async-storage";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SessionProvider } from "../src/lib/session";

void SplashScreen.preventAutoHideAsync();

const MOBILE_CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

export default function RootLayout() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            gcTime: MOBILE_CACHE_MAX_AGE,
            networkMode: "offlineFirst",
            refetchOnReconnect: true,
            retry: 1,
            staleTime: 30_000,
          },
        },
      })
  );
  const [persister] = useState(() =>
    createAsyncStoragePersister({
      key: "edgeever.mobile.query-cache.v1",
      storage: AsyncStorage,
      throttleTime: 1_000,
    })
  );

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <PersistQueryClientProvider
          client={queryClient}
          persistOptions={{
            buster: "native-cache-v1",
            dehydrateOptions: {
              shouldDehydrateQuery: (query) => {
                const section = query.queryKey[1];
                const isDefaultMemoList =
                  section === "memos" &&
                  query.queryKey[2] === "notebook" &&
                  query.queryKey[3] === "all" &&
                  query.queryKey[4] === "all" &&
                  query.queryKey[5] === "updated-desc";

                return query.state.status === "success" && (section === "notebooks" || isDefaultMemoList);
              },
            },
            maxAge: MOBILE_CACHE_MAX_AGE,
            persister,
          }}
        >
          <SessionProvider>
            <Stack screenOptions={{ headerShown: false }} />
            <StatusBar style="dark" />
          </SessionProvider>
        </PersistQueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
