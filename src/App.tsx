import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import TextareaAutosize from 'react-textarea-autosize';
import { 
  Plus, 
  MessageSquare, 
  Settings, 
  User as UserIcon, 
  Send, 
  ImageIcon,
  X,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Volume2,
  Trash2,
  Search,
  Sparkles,
  LogOut,
  LogIn,
  Mic,
  Menu
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { sendMessageStream, generateSpeech, ChatMessage } from './services/gemini';
import { 
  auth, 
  db, 
  googleProvider, 
  signInWithPopup, 
  onAuthStateChanged, 
  doc, 
  getDoc,
  setDoc, 
  collection, 
  query, 
  orderBy, 
  onSnapshot, 
  addDoc, 
  deleteDoc, 
  User 
} from './firebase';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: any;
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

interface Chat {
  id: string;
  title: string;
  createdAt: number;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [isSidebarOpen, setIsSidebarOpen] = useState(window.innerWidth >= 1024);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 1024);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedImage, setSelectedImage] = useState<{ mimeType: string; data: string } | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isScrolled, setIsScrolled] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [selectedModel, setSelectedModel] = useState<'gemini'>('gemini');
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<any>(null);

  // Responsive Listener
  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 1024;
      setIsMobile(mobile);
      // On desktop, keep sidebar open if it was open, or open it if we just transitioned from mobile
      if (!mobile && window.innerWidth >= 1024) {
        setIsSidebarOpen(true);
      } else if (mobile) {
        setIsSidebarOpen(false);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Scroll Listener
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      setIsScrolled(container.scrollTop > 10);
    };

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      setIsAuthReady(true);
      if (u) {
        const userRef = doc(db, 'users', u.uid);
        try {
          const userDoc = await getDoc(userRef);
          if (!userDoc.exists()) {
            await setDoc(userRef, {
              uid: u.uid,
              email: u.email,
              displayName: u.displayName,
              photoURL: u.photoURL,
              createdAt: new Date().toISOString()
            });
          } else {
            await setDoc(userRef, {
              displayName: u.displayName,
              photoURL: u.photoURL,
              email: u.email,
            }, { merge: true });
          }
        } catch (e) {
          handleFirestoreError(e, OperationType.WRITE, `users/${u.uid}`);
        }
      } else {
        setChats([]);
        setActiveChatId(null);
        setMessages([]);
      }
    });
    return () => unsubscribe();
  }, []);

  // Chats Listener
  useEffect(() => {
    if (!user || !isAuthReady) return;

    const chatsRef = collection(db, 'users', user.uid, 'chats');
    const q = query(chatsRef, orderBy('createdAt', 'desc'));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const chatList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Chat));
      setChats(chatList);
      
      if (chatList.length > 0 && !activeChatId && !isMobile) {
        setActiveChatId(chatList[0].id);
      }
    }, (error) => handleFirestoreError(error, OperationType.LIST, `users/${user.uid}/chats`));

    return () => unsubscribe();
  }, [user, isAuthReady, activeChatId, isMobile]);

  // Messages Listener
  useEffect(() => {
    if (!user || !activeChatId || !isAuthReady) {
      setMessages([]);
      return;
    }

    const messagesRef = collection(db, 'users', user.uid, 'chats', activeChatId, 'messages');
    const q = query(messagesRef, orderBy('createdAt', 'asc'));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const msgList = snapshot.docs.map(doc => {
        const data = doc.data();
        return {
          role: data.role,
          parts: data.parts
        } as ChatMessage;
      });
      setMessages(msgList);
    }, (error) => handleFirestoreError(error, OperationType.LIST, `users/${user.uid}/chats/${activeChatId}/messages`));

    return () => unsubscribe();
  }, [user, activeChatId, isAuthReady]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading, streamingText]);

  const login = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error('Login Error:', error);
    }
  };

  const logout = () => auth.signOut();

  const createNewChat = async () => {
    if (!user) return;
    const chatsRef = collection(db, 'users', user.uid, 'chats');
    try {
      const docRef = await addDoc(chatsRef, {
        title: 'New Conversation',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        userId: user.uid
      });
      setActiveChatId(docRef.id);
      if (isMobile) setIsSidebarOpen(false);
    } catch (e) {
      handleFirestoreError(e, OperationType.CREATE, `users/${user.uid}/chats`);
    }
  };

  const selectChat = (id: string) => {
    setActiveChatId(id);
    if (isMobile) setIsSidebarOpen(false);
  };

  const deleteChat = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!user) return;
    try {
      await deleteDoc(doc(db, 'users', user.uid, 'chats', id));
      if (activeChatId === id) setActiveChatId(null);
    } catch (e) {
      handleFirestoreError(e, OperationType.DELETE, `users/${user.uid}/chats/${id}`);
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const base64 = event.target?.result as string;
        const data = base64.split(',')[1];
        setSelectedImage({ mimeType: file.type, data });
        setPreviewUrl(base64);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSend = async () => {
    if ((!input.trim() && !selectedImage) || isLoading || !user) return;

    if (isRecording) {
      recognitionRef.current?.stop();
      setIsRecording(false);
    }

    let currentChatId = activeChatId;
    if (!currentChatId) {
      const chatsRef = collection(db, 'users', user.uid, 'chats');
      try {
        const docRef = await addDoc(chatsRef, {
          title: input.slice(0, 30) || 'New Conversation',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          userId: user.uid
        });
        currentChatId = docRef.id;
        setActiveChatId(currentChatId);
      } catch (e) {
        handleFirestoreError(e, OperationType.CREATE, `users/${user.uid}/chats`);
        return;
      }
    }

    const userMessage: ChatMessage = {
      role: 'user',
      parts: [
        { text: input },
        ...(selectedImage ? [{ inlineData: selectedImage }] : [])
      ]
    };

    const messagesRef = collection(db, 'users', user.uid, 'chats', currentChatId, 'messages');
    try {
      await addDoc(messagesRef, {
        ...userMessage,
        createdAt: Date.now()
      });
      
      if (messages.length === 0) {
        await setDoc(doc(db, 'users', user.uid, 'chats', currentChatId), {
          title: input.slice(0, 30) || 'New Conversation'
        }, { merge: true });
      }
    } catch (e) {
      handleFirestoreError(e, OperationType.CREATE, `users/${user.uid}/chats/${currentChatId}/messages`);
    }

    const currentInput = input;
    const currentImage = selectedImage;
    setInput('');
    setSelectedImage(null);
    setPreviewUrl(null);
    setIsLoading(true);

    try {
      let stream = sendMessageStream([...messages, userMessage], currentInput, currentImage || undefined);
      
      let aiResponseText = '';
      setStreamingText('');

      for await (const chunk of stream) {
        aiResponseText += chunk;
        setStreamingText(aiResponseText);
      }

      await addDoc(messagesRef, {
        role: 'model',
        parts: [{ text: aiResponseText }],
        createdAt: Date.now()
      });
    } catch (error: any) {
      console.error('Error sending message:', error);
      let errorMessage = "An error occurred while generating the response.";
      
      if (error?.error?.message) {
        errorMessage = error.error.message;
      } else if (error?.message) {
        try {
          // Try to parse JSON error message from Gemini API
          const parsed = JSON.parse(error.message.replace(/^\[.*?\]\s*/, ''));
          if (parsed.error?.message) {
            errorMessage = parsed.error.message;
          } else {
            errorMessage = error.message;
          }
        } catch (e) {
          if (error.message.includes('429') || error.message.includes('quota')) {
            errorMessage = "You have exceeded your API quota. Please check your plan and billing details at https://ai.google.dev/gemini-api/docs/rate-limits.";
          } else {
            errorMessage = error.message;
          }
        }
      } else if (typeof error === 'string') {
        try {
          const parsed = JSON.parse(error);
          if (parsed.error?.message) {
            errorMessage = parsed.error.message;
          } else {
            errorMessage = error;
          }
        } catch (e) {
          errorMessage = error;
        }
      }

      await addDoc(messagesRef, {
        role: 'model',
        parts: [{ text: `⚠️ **Error:** ${errorMessage}` }],
        createdAt: Date.now()
      });
    } finally {
      setIsLoading(false);
      setStreamingText(null);
    }
  };

  const handleTTS = async (text: string) => {
    try {
      const base64Audio = await generateSpeech(text);
      if (base64Audio) {
        const audio = new Audio(`data:audio/mp3;base64,${base64Audio}`);
        audio.play();
      }
    } catch (error) {
      console.error('TTS Error:', error);
    }
  };

  const toggleRecording = () => {
    if (isRecording) {
      recognitionRef.current?.stop();
      setIsRecording(false);
      return;
    }

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert("Speech recognition is not supported in this browser.");
      return;
    }

    const recognition = new SpeechRecognition();
    recognitionRef.current = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    
    let finalTranscript = input;

    recognition.onresult = (event: any) => {
      let interimTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
          setInput(finalTranscript);
        } else {
          interimTranscript += event.results[i][0].transcript;
          setInput(finalTranscript + interimTranscript);
        }
      }
    };

    recognition.onerror = (event: any) => {
      console.error("Speech recognition error", event.error);
      setIsRecording(false);
    };

    recognition.onend = () => {
      setIsRecording(false);
    };

    recognition.start();
    setIsRecording(true);
  };

  if (!isAuthReady) {
    return (
      <div className="h-screen bg-zinc-950 flex items-center justify-center">
        <Loader2 className="animate-spin text-emerald-500" size={40} />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="h-screen bg-zinc-950 flex flex-col items-center justify-center p-6 text-center space-y-8">
        <div className="w-20 h-20 md:w-24 md:h-24 bg-emerald-500/10 rounded-[2rem] md:rounded-[2.5rem] flex items-center justify-center border border-emerald-500/20 shadow-2xl shadow-emerald-500/5">
          <Sparkles size={40} className="text-emerald-500 md:hidden" />
          <Sparkles size={48} className="text-emerald-500 hidden md:block" />
        </div>
        <div className="space-y-4 max-w-md">
          <h1 className="text-4xl md:text-5xl font-serif italic text-zinc-100">Bihari</h1>
          <p className="text-zinc-400 text-base md:text-lg">Sign in to experience the most sophisticated AI assistant ever built.</p>
        </div>
        <button
          onClick={login}
          className="flex items-center gap-3 px-6 py-3.5 md:px-8 md:py-4 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl font-semibold transition-all shadow-xl shadow-emerald-900/20 group"
        >
          <LogIn size={20} className="group-hover:translate-x-1 transition-transform" />
          Continue with Google
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-zinc-950 overflow-hidden selection:bg-emerald-500/30">
      <AnimatePresence>
        {isMobile && isSidebarOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setIsSidebarOpen(false)}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-30"
          />
        )}
      </AnimatePresence>

      <motion.aside
        initial={false}
        animate={{ 
          width: isSidebarOpen ? (isMobile ? '100%' : 300) : 0, 
          opacity: isSidebarOpen ? 1 : 0,
          x: isMobile && !isSidebarOpen ? -300 : 0
        }}
        transition={{ type: 'spring', damping: 25, stiffness: 200 }}
        className={cn(
          "flex flex-col bg-zinc-900 border-r border-zinc-800 overflow-hidden z-40",
          isMobile ? "fixed inset-y-0 left-0 max-w-[85%]" : "relative"
        )}
      >
        <div className="p-4 flex flex-col h-full w-[300px]">
          <div className="flex items-center justify-between mb-8">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-emerald-500/10 rounded-lg flex items-center justify-center border border-emerald-500/20">
                <Sparkles size={18} className="text-emerald-500" />
              </div>
              <h2 className="text-xl font-serif italic text-zinc-100 tracking-tight">Bihari</h2>
            </div>
            {isMobile && (
              <button 
                onClick={() => setIsSidebarOpen(false)} 
                className="p-2 text-zinc-500 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors"
              >
                <X size={20} />
              </button>
            )}
          </div>

          <button
            onClick={createNewChat}
            className="flex items-center gap-3 w-full p-3.5 rounded-xl bg-emerald-600/10 border border-emerald-500/20 hover:bg-emerald-600/20 transition-all text-emerald-400 mb-8 group"
          >
            <Plus size={18} className="group-hover:rotate-90 transition-transform" />
            <span className="font-semibold text-sm">New Conversation</span>
          </button>

          <div className="flex-1 overflow-y-auto space-y-1.5 pr-2 custom-scrollbar">
            <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-[0.2em] mb-3 px-3">Recent Chats</p>
            {chats.length === 0 ? (
              <div className="px-3 py-8 text-center">
                <p className="text-xs text-zinc-600 italic">No conversations yet</p>
              </div>
            ) : (
              chats.map(chat => (
                <div
                  key={chat.id}
                  onClick={() => selectChat(chat.id)}
                  className={cn(
                    "group flex items-center justify-between p-3 rounded-xl cursor-pointer transition-all",
                    activeChatId === chat.id 
                      ? "bg-zinc-800 text-zinc-100 shadow-lg shadow-black/20" 
                      : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200"
                  )}
                >
                  <div className="flex items-center gap-3 truncate">
                    <MessageSquare size={16} className={cn("shrink-0", activeChatId === chat.id ? "text-emerald-500" : "text-zinc-600")} />
                    <span className="truncate text-sm font-medium">{chat.title}</span>
                  </div>
                  <button 
                    onClick={(e) => deleteChat(chat.id, e)}
                    className="opacity-0 group-hover:opacity-100 p-1.5 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-all"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="pt-6 border-t border-zinc-800 space-y-2">
            <button className="flex items-center gap-3 w-full p-3 rounded-xl text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-all group">
              <Settings size={18} className="group-hover:rotate-45 transition-transform" />
              <span className="text-sm font-medium">Settings</span>
            </button>
            <div className="flex items-center justify-between p-3 rounded-xl bg-zinc-800/30 border border-zinc-800/50 text-zinc-400 group">
              <div className="flex items-center gap-3 truncate">
                <img src={user.photoURL || ''} className="w-7 h-7 rounded-full border border-zinc-700" alt="Avatar" />
                <span className="text-sm font-medium truncate text-zinc-200">{user.displayName}</span>
              </div>
              <button 
                onClick={logout} 
                className="p-1.5 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-all"
                title="Logout"
              >
                <LogOut size={14} />
              </button>
            </div>
          </div>
        </div>
      </motion.aside>

      <main className="flex-1 flex flex-col relative min-w-0 h-full">
        <header className={cn(
          "h-16 flex items-center justify-between px-4 md:px-6 border-b transition-all duration-300 z-30",
          isScrolled ? "bg-zinc-950/80 backdrop-blur-xl border-zinc-800" : "bg-transparent border-transparent"
        )}>
          <div className="flex items-center gap-3 md:gap-4">
            <button 
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              className="p-2.5 hover:bg-zinc-900 rounded-xl text-zinc-400 hover:text-zinc-100 transition-all active:scale-95"
            >
              {isMobile ? <Menu size={20} /> : (isSidebarOpen ? <ChevronLeft size={20} /> : <ChevronRight size={20} />)}
            </button>
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 md:w-8 md:h-8 bg-emerald-500/10 rounded-lg flex items-center justify-center border border-emerald-500/20">
                <Sparkles size={16} className="text-emerald-500" />
              </div>
              <h1 className="text-lg md:text-xl font-serif italic tracking-tight text-zinc-100">
                Bihari
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold tracking-tight text-white">Bihar AI</h1>
          </div>
          <div className="flex items-center gap-3">
            {/* Model selection removed */}
          </div>
        </header>

        <div 
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto p-4 md:p-6 space-y-8 md:space-y-10 scroll-smooth custom-scrollbar"
        >
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center max-w-2xl mx-auto space-y-8 md:space-y-12">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-4 md:space-y-6"
              >
                <div className="w-16 h-16 md:w-20 md:h-20 bg-emerald-500/10 rounded-2xl md:rounded-3xl flex items-center justify-center mx-auto border border-emerald-500/20">
                  <Sparkles size={32} className="text-emerald-500 md:hidden" />
                  <Sparkles size={40} className="text-emerald-500 hidden md:block" />
                </div>
                <div className="space-y-2">
                  <h2 className="text-3xl md:text-4xl font-serif italic text-zinc-100">Welcome back, {user.displayName?.split(' ')[0]}.</h2>
                  <p className="text-zinc-400 text-base md:text-lg">The future is here. What shall we achieve today?</p>
                </div>
              </motion.div>
              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-3xl">
                {[
                  { icon: <Search size={18} />, title: "Real-time Search", desc: "Latest web intelligence", prompt: "What are the biggest news stories in tech today?" },
                  { icon: <ImageIcon size={18} />, title: "Image Analysis", desc: "Discuss any visual content", prompt: "Analyze this image and tell me what's interesting about it" },
                  { icon: <Volume2 size={18} />, title: "Voice Synthesis", desc: "Natural AI narration", prompt: "Read me a short story in a professional tone" },
                  { icon: <MessageSquare size={18} />, title: "Complex Reasoning", desc: "Solve difficult problems", prompt: "Help me write a complex React component with animations" }
                ].map((item, i) => (
                  <motion.button
                    key={i}
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: i * 0.1 }}
                    onClick={() => setInput(item.prompt)}
                    className="p-5 rounded-2xl bg-zinc-900/50 border border-zinc-800/50 hover:border-emerald-500/50 hover:bg-zinc-800/50 transition-all text-left group relative overflow-hidden active:scale-[0.98]"
                  >
                    <div className="absolute top-0 right-0 p-4 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Plus size={14} className="text-emerald-500" />
                    </div>
                    <div className="p-2.5 w-fit rounded-xl bg-zinc-800 group-hover:bg-emerald-500/10 group-hover:text-emerald-400 transition-colors mb-4">
                      {item.icon}
                    </div>
                    <h3 className="font-semibold text-zinc-100 mb-1 text-sm md:text-base">{item.title}</h3>
                    <p className="text-[11px] md:text-xs text-zinc-500 leading-relaxed font-medium">{item.desc}</p>
                  </motion.button>
                ))}
              </div>
            </div>
          ) : (
            <div className="max-w-4xl mx-auto space-y-8 md:space-y-10 pb-10">
              {messages.map((msg, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={cn(
                    "flex gap-3 md:gap-6",
                    msg.role === 'user' ? "flex-row-reverse" : "flex-row"
                  )}
                >
                  <div className={cn(
                    "w-8 h-8 md:w-10 md:h-10 rounded-xl md:rounded-2xl shrink-0 flex items-center justify-center border",
                    msg.role === 'user' ? "bg-zinc-800 border-zinc-700" : "bg-emerald-600 border-emerald-500"
                  )}>
                    {msg.role === 'user' ? <UserIcon size={16} className="md:size-5" /> : <Sparkles size={16} className="text-white md:size-5" />}
                  </div>
                  <div className={cn(
                    "max-w-[85%] md:max-w-[80%] space-y-2 md:space-y-3",
                    msg.role === 'user' ? "items-end" : "items-start"
                  )}>
                    <div className={cn(
                      "p-4 md:p-5 rounded-2xl md:rounded-3xl shadow-sm",
                      msg.role === 'user' ? "bg-zinc-800 text-zinc-100" : "bg-zinc-900 border border-zinc-800"
                    )}>
                      {msg.parts.map((part, pi) => (
                        <div key={pi}>
                          {part.text && (
                            <div className="markdown-body text-sm md:text-base">
                              <ReactMarkdown>{part.text}</ReactMarkdown>
                            </div>
                          )}
                          {part.inlineData && (
                            <div className="mt-3 md:mt-4 rounded-xl md:rounded-2xl overflow-hidden border border-zinc-700 shadow-lg">
                              <img 
                                src={`data:${part.inlineData.mimeType};base64,${part.inlineData.data}`} 
                                alt="Uploaded" 
                                className="max-w-full h-auto"
                                referrerPolicy="no-referrer"
                              />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                    {msg.role === 'model' && msg.parts[0].text && (
                      <div className="flex items-center gap-2">
                        <button 
                          onClick={() => handleTTS(msg.parts[0].text!)}
                          className="p-1.5 md:p-2 hover:bg-zinc-900 rounded-lg md:rounded-xl text-zinc-500 hover:text-emerald-400 transition-all flex items-center gap-1.5 md:gap-2 text-[10px] md:text-xs font-medium"
                          title="Listen"
                        >
                          <Volume2 size={12} className="md:size-3.5" />
                          <span>Listen</span>
                        </button>
                      </div>
                    )}
                  </div>
                </motion.div>
              ))}
              
              {streamingText !== null && (
                <div className="flex gap-3 md:gap-6">
                  <div className="w-8 h-8 md:w-10 md:h-10 rounded-xl md:rounded-2xl bg-emerald-600 shrink-0 flex items-center justify-center border border-emerald-500">
                    <Sparkles size={16} className="text-white md:size-5" />
                  </div>
                  <div className="max-w-[85%] md:max-w-[80%] space-y-2 md:space-y-3 items-start">
                    <div className="p-4 md:p-5 rounded-2xl md:rounded-3xl bg-zinc-900 border border-zinc-800 shadow-sm">
                      <div className="markdown-body text-sm md:text-base">
                        <ReactMarkdown>{streamingText}</ReactMarkdown>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {isLoading && streamingText === '' && (
                <div className="flex gap-3 md:gap-6">
                  <div className="w-8 h-8 md:w-10 md:h-10 rounded-xl md:rounded-2xl bg-emerald-600 shrink-0 flex items-center justify-center border border-emerald-500">
                    <Sparkles size={16} className="text-white animate-pulse md:size-5" />
                  </div>
                  <div className="p-4 md:p-5 rounded-2xl md:rounded-3xl bg-zinc-900 border border-zinc-800 flex items-center gap-3">
                    <div className="flex gap-1">
                      <motion.div animate={{ scale: [1, 1.5, 1] }} transition={{ repeat: Infinity, duration: 1 }} className="w-1 h-1 md:w-1.5 md:h-1.5 bg-emerald-500 rounded-full" />
                      <motion.div animate={{ scale: [1, 1.5, 1] }} transition={{ repeat: Infinity, duration: 1, delay: 0.2 }} className="w-1 h-1 md:w-1.5 md:h-1.5 bg-emerald-500 rounded-full" />
                      <motion.div animate={{ scale: [1, 1.5, 1] }} transition={{ repeat: Infinity, duration: 1, delay: 0.4 }} className="w-1 h-1 md:w-1.5 md:h-1.5 bg-emerald-500 rounded-full" />
                    </div>
                    <span className="text-[10px] md:text-sm text-zinc-500 font-medium tracking-wide">Thinking...</span>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        <div className="p-4 md:p-6 bg-gradient-to-t from-zinc-950 via-zinc-950 to-transparent z-20">
          <div className="max-w-4xl mx-auto relative">
            <AnimatePresence>
              {previewUrl && (
                <motion.div
                  initial={{ opacity: 0, y: 10, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 10, scale: 0.95 }}
                  className="absolute bottom-full mb-4 p-3 bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl flex items-center gap-4 min-w-[200px] backdrop-blur-xl"
                >
                  <div className="relative group">
                    <img src={previewUrl} alt="Preview" className="w-12 h-12 md:w-16 md:h-16 object-cover rounded-xl border border-zinc-700" />
                    <button 
                      onClick={() => { setSelectedImage(null); setPreviewUrl(null); }}
                      className="absolute -top-2 -right-2 p-1.5 bg-zinc-800 border border-zinc-700 rounded-full text-zinc-400 hover:text-white shadow-lg transition-colors"
                    >
                      <X size={12} />
                    </button>
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-bold text-zinc-200">Image attached</p>
                    <p className="text-[10px] text-zinc-500 uppercase tracking-wider font-bold">Ready for analysis</p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="relative flex items-end gap-2 bg-zinc-900/50 border border-zinc-800/50 rounded-[1.5rem] md:rounded-[2.5rem] p-2 md:p-3 focus-within:border-emerald-500/50 focus-within:bg-zinc-900 transition-all shadow-2xl group backdrop-blur-sm">
              <div className="flex items-center gap-1 pb-1 pl-1">
                <button 
                  onClick={() => fileInputRef.current?.click()}
                  className="p-2.5 hover:bg-zinc-800 rounded-xl md:rounded-2xl text-zinc-400 hover:text-emerald-400 transition-all active:scale-90"
                  title="Attach Image"
                >
                  <ImageIcon size={20} />
                </button>
                <button 
                  onClick={toggleRecording}
                  className={cn(
                    "p-2.5 rounded-xl md:rounded-2xl transition-all active:scale-90",
                    isRecording 
                      ? "bg-red-500/10 text-red-500 hover:bg-red-500/20 animate-pulse" 
                      : "hover:bg-zinc-800 text-zinc-400 hover:text-emerald-400"
                  )}
                  title={isRecording ? "Stop Recording" : "Voice Input"}
                >
                  <Mic size={20} />
                </button>
              </div>
              
              <TextareaAutosize
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder="Ask anything..."
                className="flex-1 bg-transparent border-none focus:ring-0 text-zinc-100 placeholder-zinc-600 py-3 px-3 resize-none max-h-40 md:max-h-60 min-h-[44px] text-base md:text-lg leading-relaxed"
                minRows={1}
              />

              <button
                onClick={handleSend}
                disabled={(!input.trim() && !selectedImage) || isLoading}
                className={cn(
                  "p-3 md:p-4 rounded-xl md:rounded-[1.5rem] transition-all shrink-0 active:scale-95",
                  (input.trim() || selectedImage) && !isLoading
                    ? "bg-emerald-600 text-white hover:bg-emerald-500 shadow-lg shadow-emerald-900/40"
                    : "bg-zinc-800 text-zinc-600 cursor-not-allowed"
                )}
              >
                {isLoading ? <Loader2 size={20} className="animate-spin" /> : <Send size={20} />}
              </button>
            </div>
            
            <p className="text-[9px] text-zinc-700 text-center mt-4 uppercase tracking-[0.4em] font-black opacity-50">
              Bihar AI
            </p>
          </div>
        </div>

        <input 
          type="file" 
          ref={fileInputRef} 
          onChange={handleImageUpload} 
          accept="image/*" 
          className="hidden" 
        />
      </main>
    </div>
  );
}
